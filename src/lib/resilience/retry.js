/**
 * Bounded exponential backoff with full jitter.
 *
 * delay = random(0, min(maxDelay, baseDelay * 2^attempt))
 */
function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const capped = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
  return Math.random() * capped;
}

/**
 * Default transient error predicate: checks status codes, error codes,
 * and message keywords commonly associated with transient failures.
 *
 * @param {Error} error
 * @returns {boolean}
 */
export function defaultIsTransientError(error) {
  if (!error) return false;

  const status = error?.response?.status ?? error?.status ?? error?.statusCode;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;

  const code = error?.code || "";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EAI_AGAIN") return true;

  const name = error?.name || "";
  if (name === "TimeoutError" || name === "AbortError") return true;

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("connection")
  );
}

/**
 * Retry a function on transient failures with bounded exponential backoff
 * and full jitter.
 *
 * **Idempotency guard**: By default (`idempotent: false`), retries are
 * skipped entirely — the function is called exactly once and the error is
 * propagated immediately. Pass `{ idempotent: true }` to enable retry logic.
 * This prevents accidental duplication of non-idempotent side effects.
 *
 * @param {() => Promise<T>} fn  — the operation to retry (must be a factory so it can be called again)
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.baseDelayMs=200]
 * @param {number} [opts.maxDelayMs=10000]
 * @param {boolean} [opts.idempotent=false]  — true to enable retry; false = single attempt
 * @param {(error: Error) => boolean} [opts.isTransientError]  — defaults to defaultIsTransientError
 * @param {(attempt: number, error: Error, delayMs: number) => void} [opts.onRetry]  — called before each retry delay
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 10000,
    idempotent = false,
    isTransientError = defaultIsTransientError,
    onRetry,
  } = opts;

  const attempts = Math.max(1, maxAttempts);

  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt >= attempts - 1;
      const canRetry = idempotent && attempt < attempts - 1 && isTransientError(error);

      if (isLastAttempt || !canRetry) {
        break;
      }

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      if (onRetry) {
        onRetry(attempt + 1, error, Math.round(delay));
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
