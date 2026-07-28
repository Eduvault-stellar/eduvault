export { withTimeout } from "./timeout.js";
export { withRetry, defaultIsTransientError } from "./retry.js";
export { createCircuitBreaker, CircuitState } from "./circuitBreaker.js";
export { classifyOperation, isIdempotent, getClassificationTable } from "./classification.js";

/**
 * Application-level error for external dependency failures.
 *
 * Carries enough structure for API error handlers to produce appropriate
 * HTTP responses with user-facing recovery hints and correlation IDs.
 */
export class DependencyError extends Error {
  /**
   * @param {object} params
   * @param {string} params.dependency   — e.g. "mongodb", "stellar-horizon"
   * @param {string} params.action       — e.g. "loadAccount", "insertOne"
   * @param {boolean} [params.retryable]  — true if caller can retry safely
   * @param {number} [params.statusCode]  — suggested HTTP status (503, 502, etc.)
   * @param {string} [params.userMessage] — user-facing message for error response
   * @param {Error} [params.cause]       — original error
   */
  constructor({ dependency, action, retryable = true, statusCode = 503, userMessage, cause }) {
    const msg = `[${dependency}] ${action} failed`;
    super(msg);
    this.name = "DependencyError";
    this.dependency = dependency;
    this.action = action;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.userMessage = userMessage || `${dependency} is temporarily unavailable. Please try again later.`;
    this.cause = cause;
  }
}

/**
 * Generalized transient-error checker.
 *
 * Covers HTTP status codes, Node system error codes, and common message
 * keywords. Delegates to the retry module's default predicate.
 */
export { defaultIsTransientError as isTransientError };
