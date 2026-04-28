import { app, InvocationContext } from '@azure/functions';
import { axiosWithRetry, withDlqHandling } from '../shared/retry';
import { buildAccountUpdateRequest, updateSalesforceRecords } from '../shared/salesforce';
import { AcsDemographicData, IncomeTier, PropertyMessagePayload } from '../shared/types';

const SERVICE_BUS_TOPIC = process.env['SERVICE_BUS_TOPIC_NAME'] ?? 'property-events';
const SUBSCRIPTION_NAME = 'sub-demographics';

/**
 * Census American Community Survey (ACS) 5-Year Estimates API.
 * Docs: https://www.census.gov/data/developers/data-sets/acs-5year.html
 */
const ACS_API_BASE = 'https://api.census.gov/data/2022/acs/acs5';

/** Optional Census API key – improves rate limits */
const CENSUS_API_KEY = process.env['CENSUS_API_KEY'];

/** Maryland FIPS state code */
const MD_STATE_FIPS = '24';

// ─── Maryland-specific Income Classification Tiers ────────────────────────────
//
// Tiers are based on Maryland median household income distribution and
// typical High-Net-Worth / Ultra-High-Net-Worth thresholds used in
// wealth management for the Maryland market.
//
// 2022 Maryland Median Household Income: ~$94,000
//   Standard:            < $75,000
//   Affluent:            $75,000 – $149,999
//   High Net Worth:      $150,000 – $299,999
//   Ultra High Net Worth: ≥ $300,000

const MARYLAND_INCOME_TIERS: Array<{ tier: IncomeTier; minIncome: number }> = [
  { tier: 'Ultra High Net Worth', minIncome: 300_000 },
  { tier: 'High Net Worth', minIncome: 150_000 },
  { tier: 'Affluent', minIncome: 75_000 },
  { tier: 'Standard', minIncome: 0 },
];

/**
 * Classifies a congressional district into an income tier based on
 * Maryland-specific income thresholds.
 *
 * @param medianHouseholdIncome  Median household income for the district
 * @returns                      Income tier classification
 */
export function classifyIncomeTier(medianHouseholdIncome: number): IncomeTier {
  for (const { tier, minIncome } of MARYLAND_INCOME_TIERS) {
    if (medianHouseholdIncome >= minIncome) {
      return tier;
    }
  }
  return 'Standard';
}

/**
 * Fetches ACS demographic data for a specific congressional district in Maryland.
 *
 * ACS variables used:
 *  B19013_001E – Median Household Income in the Past 12 Months
 *  B01003_001E – Total Population
 *  B15003_022E – Bachelor's degree (25+ population)
 *  B15003_023E – Master's degree
 *  B15003_024E – Professional school degree
 *  B15003_025E – Doctorate degree
 *  B15003_017E – Total population 25+ (denominator for education)
 *
 * @param districtGeoId  Full GEOID of the congressional district (e.g. "2404" for MD-04)
 * @param context        Azure InvocationContext for logging
 */
async function fetchAcsDemographics(
  districtGeoId: string,
  context: InvocationContext,
): Promise<AcsDemographicData> {
  // GEOID format for congressional districts: <state_fips><district_number>
  // e.g. "2404" = Maryland 4th Congressional District
  const districtNumber = districtGeoId.startsWith(MD_STATE_FIPS)
    ? districtGeoId.slice(MD_STATE_FIPS.length)
    : districtGeoId;

  const variables = [
    'B19013_001E', // Median household income
    'B01003_001E', // Total population
    'B15003_001E', // Total population 25 years and over (education denominator)
    'B15003_022E', // Bachelor's degree
    'B15003_023E', // Master's degree
    'B15003_024E', // Professional school degree
    'B15003_025E', // Doctorate degree
  ].join(',');

  const params: Record<string, string> = {
    get: `NAME,${variables}`,
    for: `congressional district:${districtNumber}`,
    in: `state:${MD_STATE_FIPS}`,
  };

  if (CENSUS_API_KEY) {
    params['key'] = CENSUS_API_KEY;
  }

  context.log(
    `[IncomeClassification] Querying ACS API for congressional district GEOID=${districtGeoId}`,
  );

  const response = await axiosWithRetry<string[][]>(
    {
      method: 'GET',
      url: ACS_API_BASE,
      params,
      timeout: 20_000,
    },
    context,
  );

  const rows = response.data;
  if (!rows || rows.length < 2) {
    throw new Error(
      `[IncomeClassification] ACS API returned no data for district GEOID=${districtGeoId}`,
    );
  }

  // Row 0 = header, Row 1 = data
  const headers = rows[0];
  const data = rows[1];

  const getValue = (variable: string): number => {
    const idx = headers.indexOf(variable);
    if (idx === -1) return 0;
    const val = parseInt(data[idx] ?? '0', 10);
    return isNaN(val) ? 0 : val;
  };

  const medianHouseholdIncome = getValue('B19013_001E');
  const totalPopulation = getValue('B01003_001E');
  const pop25Plus = getValue('B15003_001E');

  // Education percentage: (bachelor + master + professional + doctorate) / total 25+ population
  const educatedPop =
    getValue('B15003_022E') +
    getValue('B15003_023E') +
    getValue('B15003_024E') +
    getValue('B15003_025E');

  const percentBachelorOrHigher =
    pop25Plus > 0 ? (educatedPop / pop25Plus) * 100 : 0;

  return {
    congressionalDistrictGeoId: districtGeoId,
    medianHouseholdIncome,
    totalPopulation,
    percentBachelorOrHigher: Math.round(percentBachelorOrHigher * 10) / 10,
  };
}

/**
 * Azure Function handler: Income Classification (Demographics)
 *
 * Triggered by the 'sub-demographics' Service Bus subscription.
 * Uses the Census ACS API to fetch median household income and demographic
 * data for the congressional district, classifies the area into an income
 * tier (Standard / Affluent / HNW / UHNW), and updates the Salesforce Account.
 */
async function incomeClassificationHandler(
  message: unknown,
  context: InvocationContext,
): Promise<void> {
  const messageId = context.triggerMetadata?.['messageId'] as string ?? 'unknown';

  await withDlqHandling(
    async () => {
      const payload = message as PropertyMessagePayload;
      context.log(
        `[IncomeClassification] Processing message ${messageId} for accountId=${payload.accountId}`,
      );

      const districtGeoId = payload.congressionalDistrictGeoId;
      if (!districtGeoId) {
        throw new Error(
          `[IncomeClassification] Missing congressionalDistrictGeoId in message for accountId=${payload.accountId}`,
        );
      }

      const demographics = await fetchAcsDemographics(districtGeoId, context);
      const incomeTier = classifyIncomeTier(demographics.medianHouseholdIncome);

      context.log(
        `[IncomeClassification] AccountId=${payload.accountId} | ` +
          `District=${districtGeoId} | ` +
          `Median Income=$${demographics.medianHouseholdIncome.toLocaleString()} | ` +
          `Tier=${incomeTier}`,
      );

      const accountFields: Record<string, unknown> = {
        Income_Tier__c: incomeTier,
        Congressional_District_GEOID__c: districtGeoId,
        District_Median_Income__c: demographics.medianHouseholdIncome,
        District_Total_Population__c: demographics.totalPopulation,
        District_Pct_Bachelor_Plus__c: demographics.percentBachelorOrHigher ?? null,
      };

      const updateRequest = buildAccountUpdateRequest(
        payload.accountId,
        accountFields,
        `demographicsUpdate_${payload.accountId}`,
      );

      await updateSalesforceRecords([updateRequest], context);
      context.log(
        `[IncomeClassification] Salesforce update complete for accountId=${payload.accountId} with tier=${incomeTier}`,
      );
    },
    context,
    messageId,
  );
}

// Register the Azure Function with the v4 programming model
app.serviceBusTopic('incomeClassification', {
  topicName: SERVICE_BUS_TOPIC,
  subscriptionName: SUBSCRIPTION_NAME,
  connection: 'SERVICE_BUS_NAMESPACE',
  handler: incomeClassificationHandler,
});
