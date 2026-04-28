/**
 * Shared types used across all Azure Functions.
 */

/** Payload received from the Service Bus Topic */
export interface PropertyMessagePayload {
  /** Salesforce Account record ID */
  accountId: string;
  /** Street address */
  street: string;
  /** City */
  city: string;
  /** State (2-letter abbreviation) */
  state: string;
  /** ZIP code */
  zip: string;
  /** Optional: pre-resolved congressional district GEOID (used by sub-demographics) */
  congressionalDistrictGeoId?: string;
  /** Optional: latitude from prior geocoding step */
  latitude?: number;
  /** Optional: longitude from prior geocoding step */
  longitude?: number;
}

/** Census Geocoding API – matched address result */
export interface CensusGeocodeResult {
  isMatch: boolean;
  matchedAddress?: string;
  coordinates?: {
    x: number; // longitude
    y: number; // latitude
  };
  tigerLineId?: string;
  side?: string;
  stateCode?: string;
  countyCode?: string;
  censusBlockCode?: string;
  censusTractCode?: string;
}

/** Census Geography API – legislative district result */
export interface LegislativeDistricts {
  federalCongressionalDistrict?: DistrictInfo;
  mdStateSenateDistrict?: DistrictInfo;
  mdStateHouseDistrict?: DistrictInfo;
}

export interface DistrictInfo {
  geoid: string;
  name: string;
  districtNumber?: string;
}

/** ACS demographic data for a congressional district */
export interface AcsDemographicData {
  congressionalDistrictGeoId: string;
  medianHouseholdIncome: number;
  totalPopulation: number;
  percentBachelorOrHigher?: number;
  percentWhiteCollarOccupation?: number;
}

/** Income classification tiers */
export type IncomeTier = 'Standard' | 'Affluent' | 'High Net Worth' | 'Ultra High Net Worth';

/** Salesforce Composite API record update */
export interface SalesforceCompositeRecord {
  method: 'PATCH';
  url: string;
  referenceId: string;
  body: Record<string, unknown>;
}

/** Salesforce Composite API response */
export interface SalesforceCompositeResponse {
  compositeResponse: Array<{
    body: unknown;
    httpHeaders: Record<string, string>;
    httpStatusCode: number;
    referenceId: string;
  }>;
}

/** Salesforce OAuth token response */
export interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  token_type: string;
  issued_at: string;
}
