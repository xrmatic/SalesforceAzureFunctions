import { app, InvocationContext } from '@azure/functions';
import { axiosWithRetry, withDlqHandling } from '../shared/retry';
import { buildAccountUpdateRequest, updateSalesforceRecords } from '../shared/salesforce';
import { DistrictInfo, LegislativeDistricts, PropertyMessagePayload } from '../shared/types';

const SERVICE_BUS_TOPIC = process.env['SERVICE_BUS_TOPIC_NAME'] ?? 'property-events';
const SUBSCRIPTION_NAME = 'sub-congressional-lookup';

/**
 * Census Geography API (2020 Decennial Census / TIGER data).
 * Uses the geocodes endpoint to look up districts by lat/lon.
 * Docs: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.pdf
 */
const CENSUS_GEO_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';

/** Maryland FIPS state code */
const MD_FIPS = '24';

/**
 * Calls the Census Geography API to resolve legislative districts for a
 * given latitude/longitude coordinate.
 *
 * Returns federal congressional district and Maryland state legislative
 * district information.
 *
 * @param latitude   WGS-84 latitude
 * @param longitude  WGS-84 longitude
 * @param context    Azure InvocationContext for logging
 */
async function fetchLegislativeDistricts(
  latitude: number,
  longitude: number,
  context: InvocationContext,
): Promise<LegislativeDistricts> {
  context.log(
    `[LegislativeMapping] Querying Census Geography API for coordinates (${latitude}, ${longitude})`,
  );

  const response = await axiosWithRetry<CensusGeoCoordinatesResponse>(
    {
      method: 'GET',
      url: CENSUS_GEO_URL,
      params: {
        x: longitude,
        y: latitude,
        benchmark: 'Public_AR_Census2020',
        vintage: 'Census2020_Census2020',
        layers: 'Congressional Districts,State Legislative Districts (Upper Chamber),State Legislative Districts (Lower Chamber)',
        format: 'json',
      },
      timeout: 15_000,
    },
    context,
  );

  const geographies = response.data?.result?.geographies ?? {};
  const result: LegislativeDistricts = {};

  // Federal Congressional Districts
  const cdArray = geographies['Congressional Districts'] ?? [];
  if (cdArray.length > 0) {
    const cd = cdArray[0];
    result.federalCongressionalDistrict = {
      geoid: cd['GEOID'] ?? '',
      name: cd['NAME'] ?? '',
      districtNumber: cd['CD118'] ?? cd['CD116'] ?? cd['DISTRICT'] ?? '',
    };
  }

  // Maryland State Senate (Upper Chamber) – filter to MD FIPS
  const upperArray = (geographies['State Legislative Districts (Upper Chamber)'] ?? []).filter(
    (d) => d['STATE'] === MD_FIPS,
  );
  if (upperArray.length > 0) {
    const upper = upperArray[0];
    result.mdStateSenateDistrict = {
      geoid: upper['GEOID'] ?? '',
      name: upper['NAME'] ?? '',
      districtNumber: upper['SLDUST'] ?? '',
    };
  }

  // Maryland State House (Lower Chamber) – filter to MD FIPS
  const lowerArray = (geographies['State Legislative Districts (Lower Chamber)'] ?? []).filter(
    (d) => d['STATE'] === MD_FIPS,
  );
  if (lowerArray.length > 0) {
    const lower = lowerArray[0];
    result.mdStateHouseDistrict = {
      geoid: lower['GEOID'] ?? '',
      name: lower['NAME'] ?? '',
      districtNumber: lower['SLDLST'] ?? '',
    };
  }

  return result;
}

/**
 * Uses the Census Geocoding API to resolve coordinates from a street address,
 * then fetches legislative districts for those coordinates.
 * Called as a fallback when lat/lon is not present in the message payload.
 */
async function geocodeAndFetchDistricts(
  payload: PropertyMessagePayload,
  context: InvocationContext,
): Promise<LegislativeDistricts> {
  context.log(
    `[LegislativeMapping] No coordinates in payload – geocoding address for accountId=${payload.accountId}`,
  );

  const geoResponse = await axiosWithRetry<CensusGeocodeAddressResponse>(
    {
      method: 'GET',
      url: 'https://geocoding.geo.census.gov/geocoder/geographies/address',
      params: {
        street: payload.street,
        city: payload.city,
        state: payload.state,
        zip: payload.zip,
        benchmark: 'Public_AR_Census2020',
        vintage: 'Census2020_Census2020',
        layers: 'Congressional Districts,State Legislative Districts (Upper Chamber),State Legislative Districts (Lower Chamber)',
        format: 'json',
      },
      timeout: 15_000,
    },
    context,
  );

  const addressMatches = geoResponse.data?.result?.addressMatches ?? [];
  if (addressMatches.length === 0) {
    context.log(`[LegislativeMapping] No address match found for accountId=${payload.accountId}`);
    return {};
  }

  const coords = addressMatches[0].coordinates;
  if (!coords) return {};

  return fetchLegislativeDistricts(coords.y, coords.x, context);
}

/**
 * Converts a DistrictInfo to the Salesforce field set for legislative mapping.
 */
function buildDistrictFields(districts: LegislativeDistricts): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  if (districts.federalCongressionalDistrict) {
    fields['Federal_Congressional_District__c'] = districts.federalCongressionalDistrict.name;
    fields['Federal_CD_GEOID__c'] = districts.federalCongressionalDistrict.geoid;
    fields['Federal_CD_Number__c'] = districts.federalCongressionalDistrict.districtNumber ?? null;
  }

  if (districts.mdStateSenateDistrict) {
    fields['MD_State_Senate_District__c'] = districts.mdStateSenateDistrict.name;
    fields['MD_Senate_GEOID__c'] = districts.mdStateSenateDistrict.geoid;
    fields['MD_Senate_District_Number__c'] = districts.mdStateSenateDistrict.districtNumber ?? null;
  }

  if (districts.mdStateHouseDistrict) {
    fields['MD_State_House_District__c'] = districts.mdStateHouseDistrict.name;
    fields['MD_House_GEOID__c'] = districts.mdStateHouseDistrict.geoid;
    fields['MD_House_District_Number__c'] = districts.mdStateHouseDistrict.districtNumber ?? null;
  }

  return fields;
}

/**
 * Azure Function handler: Legislative Mapping
 *
 * Triggered by the 'sub-congressional-lookup' Service Bus subscription.
 * Determines the Federal Congressional District and Maryland State
 * Legislative Districts for a property and updates the Salesforce Account.
 */
async function legislativeMappingHandler(
  message: unknown,
  context: InvocationContext,
): Promise<void> {
  const messageId = context.triggerMetadata?.['messageId'] as string ?? 'unknown';

  await withDlqHandling(
    async () => {
      const payload = message as PropertyMessagePayload;
      context.log(
        `[LegislativeMapping] Processing message ${messageId} for accountId=${payload.accountId}`,
      );

      let districts: LegislativeDistricts;

      if (payload.latitude !== undefined && payload.longitude !== undefined) {
        districts = await fetchLegislativeDistricts(payload.latitude, payload.longitude, context);
      } else {
        districts = await geocodeAndFetchDistricts(payload, context);
      }

      const districtFields = buildDistrictFields(districts);

      if (Object.keys(districtFields).length === 0) {
        context.log(
          `[LegislativeMapping] No district data resolved for accountId=${payload.accountId}`,
        );
        return;
      }

      const updateRequest = buildAccountUpdateRequest(
        payload.accountId,
        districtFields,
        `legislativeUpdate_${payload.accountId}`,
      );

      await updateSalesforceRecords([updateRequest], context);
      context.log(
        `[LegislativeMapping] Salesforce update complete for accountId=${payload.accountId}. ` +
          `Districts: ${JSON.stringify(districts)}`,
      );
    },
    context,
    messageId,
  );
}

// Register the Azure Function with the v4 programming model
app.serviceBusTopic('legislativeMapping', {
  topicName: SERVICE_BUS_TOPIC,
  subscriptionName: SUBSCRIPTION_NAME,
  connection: 'SERVICE_BUS_NAMESPACE',
  handler: legislativeMappingHandler,
});

// ─── Internal Census API response types ──────────────────────────────────────

interface CensusGeoCoordinatesResponse {
  result?: {
    geographies?: Record<string, Array<Record<string, string>>>;
  };
}

interface CensusGeocodeAddressResponse {
  result?: {
    addressMatches?: Array<{
      matchedAddress: string;
      coordinates?: { x: number; y: number };
      geographies?: Record<string, Array<Record<string, string>>>;
    }>;
  };
}
