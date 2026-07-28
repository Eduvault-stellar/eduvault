/**
 * Circuit breaker states.
 */
export const CircuitState = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

/**
 * Create a circuit breaker for a named dependency.
 *
 * State machine:
 *   CLOSED → (failure threshold reached) → OPEN
 *   OPEN → (reset timeout elapsed) → HALF_OPEN
 *   HALF_OPEN → (probe succeeds) → CLOSED
 *   HALF_OPEN → (probe fails) → OPEN
 *
 * State transitions emit a callback (`onStateChange`) so callers can
 * update metrics, logs, or readiness checks.
 *
 * @param {string} name  — dependency name (used in metrics/errors)
 * @param {object} [opts]
 * @param {number} [opts.failureThreshold=5]  — consecutive failures before opening
 * @param {number} [opts.successThreshold=2]  — consecutive successes in half-open to close
 * @param {number} [opts.resetTimeoutMs=30000]  — time before transitioning open→half-open
 * @param {(name: string, from: string, to: string) => void} [opts.onStateChange]
 * @returns {{
 *   call: <T>(fn: () => Promise<T>, fallback?: () => Promise<T>) => Promise<T>,
 *   recordSuccess: () => void,
 *   recordFailure: () => void,
 *   getState: () => string,
 *   forceState: (state: string) => void,
 *   getName: () => string,
 * }}
 */
export function createCircuitBreaker(name, opts = {}) {
  const {
    failureThreshold = 5,
    successThreshold = 2,
    resetTimeoutMs = 30000,
    onStateChange,
  } = opts;

  let state = CircuitState.CLOSED;
  let failureCount = 0;
  let successCount = 0;
  let nextAttemptAt = 0;

  function transition(to) {
    const from = state;
    state = to;
    if (onStateChange) {
      onStateChange(name, from, to);
    }
  }

  function resetCounters() {
    failureCount = 0;
    successCount = 0;
  }

  function maybeTransitionToHalfOpen() {
    if (state === CircuitState.OPEN && Date.now() >= nextAttemptAt) {
      transition(CircuitState.HALF_OPEN);
    }
  }

  function recordFailure() {
    maybeTransitionToHalfOpen();

    failureCount++;

    if (state === CircuitState.HALF_OPEN) {
      // A single failure in half-open trips back to open
      transition(CircuitState.OPEN);
      nextAttemptAt = Date.now() + resetTimeoutMs;
      return;
    }

    if (state === CircuitState.CLOSED && failureCount >= failureThreshold) {
      transition(CircuitState.OPEN);
      nextAttemptAt = Date.now() + resetTimeoutMs;
    }
  }

  function recordSuccess() {
    maybeTransitionToHalfOpen();

    if (state === CircuitState.HALF_OPEN) {
      successCount++;
      if (successCount >= successThreshold) {
        resetCounters();
        transition(CircuitState.CLOSED);
      }
      return;
    }

    // Reset failure count on success in closed state
    if (state === CircuitState.CLOSED) {
      failureCount = 0;
    }
  }

  /**
   * Call a function through the circuit breaker.
   *
   * If the circuit is OPEN, the call is rejected immediately (fast-fail)
   * unless a `fallback` is provided, in which case the fallback is called.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {() => Promise<T>} [fallback]
   * @returns {Promise<T>}
   */
  async function call(fn, fallback) {
    if (state === CircuitState.OPEN) {
      if (Date.now() >= nextAttemptAt) {
        transition(CircuitState.HALF_OPEN);
      } else {
        if (fallback) return fallback();
        const err = new Error(`Circuit breaker open for ${name}`);
        err.name = "CircuitBreakerError";
        err.dependency = name;
        throw err;
      }
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (error) {
      recordFailure();
      throw error;
    }
  }

  function getState() {
    return state;
  }

  function forceState(s, opts = {}) {
    state = s;
    failureCount = opts.failureCount ?? 0;
    successCount = opts.successCount ?? 0;
    nextAttemptAt = opts.nextAttemptAt ?? 0;
  }

  function getName() {
    return name;
  }

  return {
    call,
    recordSuccess,
    recordFailure,
    getState,
    forceState,
    getName,
  };
}
