import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import axios from 'axios';
import {
  SalesforceCompositeRecord,
  SalesforceCompositeResponse,
  SalesforceTokenResponse,
} from './types';

/** Maximum number of records per Salesforce Composite API batch */
const COMPOSITE_BATCH_SIZE = 200;

/** Cache token to avoid re-fetching on every invocation */
let cachedToken: { accessToken: string; instanceUrl: string; expiresAt: number } | null = null;

/**
 * Retrieves a Salesforce access token using the OAuth 2.0 client credentials flow.
 * Credentials are read from environment variables (or Key Vault if KEY_VAULT_URI is set).
 */
async function getSalesforceToken(): Promise<{ accessToken: string; instanceUrl: string }> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return { accessToken: cachedToken.accessToken, instanceUrl: cachedToken.instanceUrl };
  }

  const { clientId, clientSecret, instanceUrl } = await resolveSalesforceCredentials();

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await axios.post<SalesforceTokenResponse>(
    `${instanceUrl}/services/oauth2/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const { access_token, instance_url } = response.data;
  // Salesforce tokens are valid for ~1 hour; cache for 55 minutes
  cachedToken = {
    accessToken: access_token,
    instanceUrl: instance_url,
    expiresAt: now + 55 * 60 * 1_000,
  };

  return { accessToken: access_token, instanceUrl: instance_url };
}

/**
 * Resolves Salesforce credentials.
 * Attempts Key Vault first (when KEY_VAULT_URI is set), falls back to env vars.
 */
async function resolveSalesforceCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
  instanceUrl: string;
}> {
  const keyVaultUri = process.env['KEY_VAULT_URI'];

  if (keyVaultUri) {
    const credential = new DefaultAzureCredential();
    const client = new SecretClient(keyVaultUri, credential);

    const [clientIdSecret, clientSecretSecret, instanceUrlSecret] = await Promise.all([
      client.getSecret('SalesforceClientId'),
      client.getSecret('SalesforceClientSecret'),
      client.getSecret('SalesforceInstanceUrl'),
    ]);

    return {
      clientId: clientIdSecret.value ?? '',
      clientSecret: clientSecretSecret.value ?? '',
      instanceUrl: instanceUrlSecret.value ?? '',
    };
  }

  return {
    clientId: process.env['SALESFORCE_CLIENT_ID'] ?? '',
    clientSecret: process.env['SALESFORCE_CLIENT_SECRET'] ?? '',
    instanceUrl: process.env['SALESFORCE_INSTANCE_URL'] ?? '',
  };
}

/**
 * Sends batched Composite REST API updates to Salesforce.
 * Splits records into 200-record chunks as required by the Salesforce API.
 *
 * @param records   Array of Composite sub-request objects
 * @param context   Azure Functions logger
 */
export async function updateSalesforceRecords(
  records: SalesforceCompositeRecord[],
  context: { log: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  if (records.length === 0) return;

  const { accessToken, instanceUrl } = await getSalesforceToken();

  // Split into COMPOSITE_BATCH_SIZE chunks
  for (let i = 0; i < records.length; i += COMPOSITE_BATCH_SIZE) {
    const batch = records.slice(i, i + COMPOSITE_BATCH_SIZE);
    const url = `${instanceUrl}/services/data/v60.0/composite`;

    const response = await axios.post<SalesforceCompositeResponse>(
      url,
      { allOrNone: false, compositeRequest: batch },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    for (const item of response.data.compositeResponse) {
      if (item.httpStatusCode < 200 || item.httpStatusCode >= 300) {
        context.error(
          `[Salesforce] Composite update failed for referenceId=${item.referenceId}: ` +
            `HTTP ${item.httpStatusCode} – ${JSON.stringify(item.body)}`,
        );
      } else {
        context.log(
          `[Salesforce] Successfully updated referenceId=${item.referenceId} ` +
            `(HTTP ${item.httpStatusCode})`,
        );
      }
    }
  }
}

/**
 * Builds a Salesforce Composite PATCH sub-request for a single Account record.
 *
 * @param accountId   Salesforce Account ID
 * @param fields      Key/value pairs to update
 * @param referenceId Unique reference for this sub-request (must be unique within a batch)
 */
export function buildAccountUpdateRequest(
  accountId: string,
  fields: Record<string, unknown>,
  referenceId: string,
): SalesforceCompositeRecord {
  return {
    method: 'PATCH',
    url: `/services/data/v60.0/sobjects/Account/${accountId}`,
    referenceId,
    body: fields,
  };
}
