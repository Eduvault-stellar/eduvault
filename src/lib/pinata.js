import { PinataSDK } from "pinata";
import { createCircuitBreaker, CircuitState, DependencyError } from "@/lib/resilience/index.js";
import { withTimeout } from "@/lib/resilience/timeout.js";
import { withRetry } from "@/lib/resilience/retry.js";
import { setGauge, incrementCounter } from "@/lib/telemetry/metrics";

const PINATA_TIMEOUT_MS = Number(process.env.PINATA_TIMEOUT_MS || 30000);

const pinataCircuitBreaker = createCircuitBreaker("pinata", {
  failureThreshold: Number(process.env.PINATA_CB_FAILURE_THRESHOLD || 3),
  successThreshold: 2,
  resetTimeoutMs: Number(process.env.PINATA_CB_RESET_TIMEOUT_MS || 30000),
  onStateChange(name, from, to) {
    setGauge("circuit_breaker_state", { dependency: name, state: to }, 1);
    if (from && from !== to) {
      setGauge("circuit_breaker_state", { dependency: name, state: from }, 0);
    }
    if (to === CircuitState.OPEN) {
      incrementCounter("circuit_breaker_open_total", { dependency: name });
    }
    const level = to === CircuitState.OPEN ? "warn" : "info";
    console[level](`[circuit-breaker] pinata: ${from} -> ${to}`);
  },
});

export function getPinataCircuitBreakerState() {
  return pinataCircuitBreaker.getState();
}

export async function callPinata(action, fn, opts = {}) {
  const idempotent = opts.idempotent !== false;
  if (pinataCircuitBreaker.getState() === CircuitState.OPEN) {
    incrementCounter("rpc_errors_total", { operation: `pinata.${action}` });
    throw new DependencyError({
      dependency: "pinata",
      action,
      retryable: false,
      statusCode: 503,
      userMessage: "Storage service is temporarily unavailable.",
    });
  }
  return pinataCircuitBreaker.call(async () => {
    return withRetry(
      async () => withTimeout(fn(), PINATA_TIMEOUT_MS, `pinata.${action}`),
      {
        idempotent,
        maxAttempts: Number(process.env.PINATA_RETRIES || 2),
        baseDelayMs: 500,
        maxDelayMs: 5000,
      }
    );
  });
}

export const pinata = new PinataSDK({
  pinataJwt: process.env.PINATA_JWT,
  pinataGateway: process.env.NEXT_PUBLIC_GATEWAY_URL,
});
