import { app, InvocationContext } from '@azure/functions';
import { axiosWithRetry, withDlqHandling } from '../shared/retry';
import { buildAccountUpdateRequest, updateSalesforceRecords } from '../shared/salesforce';
import { CensusGeocodeResult, PropertyMessagePayload } from '../shared/types';

const SERVICE_BUS_TOPIC = process.env['SERVICE_BUS_TOPIC_NAME'] ?? 'property-events';
const SUBSCRIPTION_NAME = 'sub-address-validation';

/**
 * Census Geocoding API base URL (One Line address lookup).
 * Docs: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.pdf
 */
const CENSUS_GEOCODE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/address';

/**
 * Calls the Census.gov Geocoding API to validate and normalise an address.
 *
 * @param street  Street address
 * @param city    City name
 * @param state   State abbreviation (e.g. "MD")
 * @param zip     ZIP code
 * @param context Azure InvocationContext for logging
 * @returns       CensusGeocodeResult with match status and normalised data
 */
async function geocodeAddress(
  street: string,
  city: string,
  state: string,
  zip: string,
  context: InvocationContext,
): Promise<CensusGeocodeResult> {
  const params = {
    street,
    city,
    state,
    zip,
    benchmark: 'Public_AR_Current',
    format: 'json',
  };

  context.log(`[AddressValidation] Calling Census Geocoding API for: ${street}, ${city}, ${state} ${zip}`);

  const response = await axiosWithRetry<CensusGeocodeAddressResponse>(
    {
      method: 'GET',
      url: CENSUS_GEOCODE_URL,
      params,
      timeout: 15_000,
    },
    context,
  );

  const addressMatches = response.data?.result?.addressMatches ?? [];

  if (addressMatches.length === 0) {
    context.log(`[AddressValidation] No match found for: ${street}, ${city}, ${state} ${zip}`);
    return { isMatch: false };
  }

  const match = addressMatches[0];
  return {
    isMatch: true,
    matchedAddress: match.matchedAddress,
    coordinates: match.coordinates
      ? { x: match.coordinates.x, y: match.coordinates.y }
      : undefined,
    tigerLineId: match.tigerLine?.tigerLineId,
    side: match.tigerLine?.side,
    stateCode: match.geographies?.['States']?.[0]?.STATE,
    countyCode: match.geographies?.['Counties']?.[0]?.COUNTY,
    censusBlockCode: match.geographies?.['Census Blocks']?.[0]?.BLOCK,
    censusTractCode: match.geographies?.['Census Tracts']?.[0]?.TRACT,
  };
}

/**
 * Parses the raw Census API geocoding response into a normalised address structure.
 */
function parseNormalisedAddress(matchedAddress: string): {
  street: string;
  city: string;
  state: string;
  zip: string;
} {
  // Matched address format: "123 MAIN ST, CITY, MD 20852"
  const parts = matchedAddress.split(',').map((p) => p.trim());
  const street = parts[0] ?? '';
  const city = parts[1] ?? '';
  const stateZip = parts[2] ?? '';
  const [state, zip] = stateZip.split(' ').filter(Boolean);
  return { street, city, state: state ?? '', zip: zip ?? '' };
}

/**
 * Azure Function handler: Address Validation
 *
 * Triggered by the 'sub-address-validation' Service Bus subscription.
 * Validates the property address against the Census Geocoding API and
 * updates the Salesforce Account record with the normalised address and
 * geocoding status.
 */
async function addressValidationHandler(
  message: unknown,
  context: InvocationContext,
): Promise<void> {
  const messageId = context.triggerMetadata?.['messageId'] as string ?? 'unknown';

  await withDlqHandling(
    async () => {
      const payload = message as PropertyMessagePayload;
      context.log(
        `[AddressValidation] Processing message ${messageId} for accountId=${payload.accountId}`,
      );

      const geocodeResult = await geocodeAddress(
        payload.street,
        payload.city,
        payload.state,
        payload.zip,
        context,
      );

      let accountFields: Record<string, unknown>;

      if (geocodeResult.isMatch && geocodeResult.matchedAddress) {
        const normalised = parseNormalisedAddress(geocodeResult.matchedAddress);
        accountFields = {
          BillingStreet: normalised.street,
          BillingCity: normalised.city,
          BillingState: normalised.state,
          BillingPostalCode: normalised.zip,
          Geocoding_Status__c: 'Validated',
          Geocoding_Latitude__c: geocodeResult.coordinates?.y ?? null,
          Geocoding_Longitude__c: geocodeResult.coordinates?.x ?? null,
          Census_Tract__c: geocodeResult.censusTractCode ?? null,
          Census_Block__c: geocodeResult.censusBlockCode ?? null,
        };
        context.log(
          `[AddressValidation] Address validated for accountId=${payload.accountId}: ${geocodeResult.matchedAddress}`,
        );
      } else {
        accountFields = {
          Geocoding_Status__c: 'Unvalidated',
        };
        context.log(
          `[AddressValidation] Address could not be validated for accountId=${payload.accountId}`,
        );
      }

      const updateRequest = buildAccountUpdateRequest(
        payload.accountId,
        accountFields,
        `addressUpdate_${payload.accountId}`,
      );

      await updateSalesforceRecords([updateRequest], context);
      context.log(
        `[AddressValidation] Salesforce update complete for accountId=${payload.accountId}`,
      );
    },
    context,
    messageId,
  );
}

// Register the Azure Function with the v4 programming model
app.serviceBusTopic('addressValidation', {
  topicName: SERVICE_BUS_TOPIC,
  subscriptionName: SUBSCRIPTION_NAME,
  connection: 'SERVICE_BUS_NAMESPACE',
  handler: addressValidationHandler,
});

// ─── Internal Census API response types ──────────────────────────────────────

interface CensusGeocodeAddressResponse {
  result?: {
    addressMatches?: Array<{
      matchedAddress: string;
      coordinates?: { x: number; y: number };
      tigerLine?: { tigerLineId: string; side: string };
      geographies?: Record<string, Array<Record<string, string>>>;
    }>;
  };
}
