import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

/** Maximum number of retry attempts for external API calls */
export const MAX_RETRY_ATTEMPTS = 5;

/** Base delay in milliseconds for the first retry */
const BASE_DELAY_MS = 1_000;

/** Maximum delay cap in milliseconds (5 minutes) */
const MAX_DELAY_MS = 5 * 60 * 1_000;

/** HTTP status codes that are considered retryable */
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Determines whether the given error should trigger a retry.
 */
function isRetryableError(error: AxiosError): boolean {
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }
  if (error.response && RETRYABLE_STATUS_CODES.has(error.response.status)) {
    return true;
  }
  return false;
}

/**
 * Calculates the exponential backoff delay with full jitter.
 * delay = min(cap, base * 2^attempt) + random jitter
 */
function calculateBackoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  // Full jitter: random value in [0, exponential]
  return Math.floor(Math.random() * exponential);
}

/**
 * Returns a promise that resolves after the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an Axios HTTP request with exponential backoff retry logic.
 *
 * @param config  Axios request configuration
 * @param context Optional logger (compatible with Azure Functions InvocationContext)
 * @returns       Axios response on success
 * @throws        The last error if all retry attempts are exhausted
 */
export async function axiosWithRetry<T = unknown>(
  config: AxiosRequestConfig,
  context?: { log: (msg: string) => void; error: (msg: string) => void },
): Promise<AxiosResponse<T>> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await axios.request<T>(config);
      return response;
    } catch (err) {
      const axiosErr = err as AxiosError;
      lastError = axiosErr;

      const isLast = attempt === MAX_RETRY_ATTEMPTS - 1;
      if (isLast || !isRetryableError(axiosErr)) {
        throw axiosErr;
      }

      const delay = calculateBackoffDelay(attempt);
      const status = axiosErr.response?.status ?? 'network error';
      context?.log(
        `[Retry] Attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS} failed ` +
          `(status: ${status}). Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Wraps a Service Bus message handler with Dead-Letter Queue (DLQ) semantics.
 *
 * If the handler throws after exhausting all retries the error is logged and
 * the function returns normally so the Service Bus SDK will dead-letter the
 * message on its own (or via the host retry policy).
 *
 * @param handler   Async function containing the actual processing logic
 * @param context   Azure Functions InvocationContext (used for logging)
 * @param messageId Identifier of the Service Bus message (for log correlation)
 */
export async function withDlqHandling(
  handler: () => Promise<void>,
  context: { log: (msg: string) => void; error: (msg: string) => void },
  messageId: string,
): Promise<void> {
  try {
    await handler();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.error(
      `[DLQ] Message ${messageId} failed after ${MAX_RETRY_ATTEMPTS} attempts. ` +
        `Error: ${message}. Message will be dead-lettered.`,
    );
    // Re-throw so the Azure Functions runtime dead-letters the message
    throw err;
  }
}
