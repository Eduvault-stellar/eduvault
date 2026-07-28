import { vi } from "vitest";
import { CircuitState } from "@/lib/resilience/circuitBreaker";

/**
 * Track all circuit breakers created in tests so they can be reset.
 * @type {Set<{ forceState: (s: string) => void, getName: () => string }>}
 */
const allCircuitBreakers = new Set();

/**
 * Register a circuit breaker for auto-cleanup.
 * Called by test code when creating breakers.
 */
export function trackCircuitBreaker(cb) {
  allCircuitBreakers.add(cb);
  return cb;
}

/**
 * Reset all tracked circuit breakers to closed state.
 */
export function resetCircuitBreakers() {
  for (const cb of allCircuitBreakers) {
    cb.forceState(CircuitState.CLOSED, {});
  }
  allCircuitBreakers.clear();
}

/**
 * Assert that a circuit breaker is in the expected state.
 */
export function expectCircuitState(cb, expectedState) {
  const actual = cb.getState();
  if (actual !== expectedState) {
    throw new Error(
      `Expected circuit breaker "${cb.getName()}" to be in state "${expectedState}", got "${actual}"`,
    );
  }
}

/**
 * Create a mock adapter function that simulates various failure modes.
 *
 * @param {object} opts
 * @param {'latency' | 'timeout' | 'connection_reset' | 'http_429' | 'http_5xx'} opts.mode
 * @param {number} [opts.delayMs]       — how long to wait before responding (latency mode)
 * @param {number} [opts.failAfter]     — number of calls before switching from success to failure
 * @param {number} [opts.statusCode]    — for http_5xx mode, the specific status code
 * @param {boolean} [opts.thenRecover]  — after failing, start succeeding again?
 * @returns {{ fn: (...args) => Promise<any>, reset: () => void }}
 */
export function createFaultyAdapter(opts = {}) {
  const {
    mode,
    delayMs = 0,
    failAfter = 0,
    statusCode = 500,
    thenRecover = false,
  } = opts;

  let callCount = 0;
  let failureCount = 0;
  const maxFailures = failAfter;

  async function fn(...args) {
    callCount++;

    // Latency simulation
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // Determine if this call should fail
    const shouldFail = maxFailures > 0 && failureCount < maxFailures;
    const isRecovered = thenRecover && failureCount >= maxFailures;

    if (shouldFail) {
      failureCount++;

      switch (mode) {
        case "timeout": {
          const err = new Error("simulated timeout");
          err.name = "TimeoutError";
          throw err;
        }
        case "connection_reset": {
          const err = new Error("read ECONNRESET");
          err.code = "ECONNRESET";
          throw err;
        }
        case "http_429": {
          const err = new Error("Too Many Requests");
          err.status = 429;
          err.response = { status: 429 };
          throw err;
        }
        case "http_5xx": {
          const err = new Error(`HTTP ${statusCode}`);
          err.status = statusCode;
          err.response = { status: statusCode };
          throw err;
        }
        case "latency":
          // Latency mode fails with a timeout after the delay
          const err = new Error("simulated timeout after latency");
          err.name = "TimeoutError";
          throw err;
        default:
          throw new Error(`Unknown fault mode: ${mode}`);
      }
    }

    // If recovered from failures, return success
    if (isRecovered) {
      return { status: "ok", recovered: true };
    }

    // Success path (when failAfter === 0)
    return { status: "ok" };
  }

  function reset() {
    callCount = 0;
    failureCount = 0;
  }

  return { fn, reset };
}

/**
 * Create a mock that simulates a flaky network connection.
 * Alternates between success and failure to test retry logic.
 *
 * @param {number} successRate  — probability of success (0.0 to 1.0)
 * @param {number} [delayMs]    — simulated latency
 * @returns {() => Promise<any>}
 */
export function createFlakyAdapter(successRate = 0.5, delayMs = 0) {
  return async (...args) => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    if (Math.random() < successRate) {
      return { status: "ok" };
    }

    const err = new Error("Flaky network error");
    err.code = "ECONNRESET";
    throw err;
  };
}

/**
 * Clean slate before each test: clear circuit breaker tracking.
 */
export function resetResilienceFixtures() {
  allCircuitBreakers.clear();
}
