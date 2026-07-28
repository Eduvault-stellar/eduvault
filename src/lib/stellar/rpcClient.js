import { STELLAR_RPC_URL } from "@/lib/config/chain";
import { createCircuitBreaker, CircuitState, DependencyError } from "@/lib/resilience/index.js";
import { withTimeout } from "@/lib/resilience/timeout.js";
import { withRetry } from "@/lib/resilience/retry.js";
import { setGauge, incrementCounter } from "@/lib/telemetry/metrics.js";
import { currentTraceparent } from "@/lib/telemetry/context";

const DEFAULT_TIMEOUT_MS = Number(process.env.STELLAR_RPC_TIMEOUT_MS || 10000);
const DEFAULT_RETRIES = Number(process.env.STELLAR_RPC_RETRIES || 2);

const rpcCircuitBreaker = createCircuitBreaker("stellar-rpc", {
  failureThreshold: Number(process.env.STELLAR_RPC_CB_FAILURE_THRESHOLD || 3),
  successThreshold: 2,
  resetTimeoutMs: Number(process.env.STELLAR_RPC_CB_RESET_TIMEOUT_MS || 30000),
  onStateChange(name, from, to) {
    setGauge("circuit_breaker_state", { dependency: name, state: to }, 1);
    if (from && from !== to) {
      setGauge("circuit_breaker_state", { dependency: name, state: from }, 0);
    }
    if (to === CircuitState.OPEN) {
      incrementCounter("circuit_breaker_open_total", { dependency: name });
    }
    const level = to === CircuitState.OPEN ? "warn" : "info";
    console[level](`[circuit-breaker] stellar-rpc: ${from} -> ${to}`);
  },
});

export function getRpcCircuitBreakerState() {
  return rpcCircuitBreaker.getState();
}

function isRpcTransientError(error) {
  if (!error) return false;
  const status = error?.response?.status ?? error?.status;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  const code = error?.code || "";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT") return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("timeout") || message.includes("timed out") || message.includes("econnreset") || message.includes("network") || message.includes("socket");
}

/**
 * Execute a JSON-RPC call to the Stellar RPC endpoint.
 *
 * @param {object} rpcRequest — { method, params }
 * @param {object} [opts]
 * @param {string} [opts.rpcUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<any>} — JSON-RPC result
 */
export async function rpcCall(rpcRequest, opts = {}) {
  const rpcUrl = opts.rpcUrl || STELLAR_RPC_URL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!rpcUrl) {
    throw new DependencyError({
      dependency: "stellar-rpc",
      action: rpcRequest.method,
      retryable: false,
      userMessage: "Stellar RPC is not configured.",
    });
  }

  const traceparent = currentTraceparent();

  const exec = async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: rpcRequest.method,
      params: rpcRequest.params || {},
    });

    const headers = {
      "Content-Type": "application/json",
    };
    if (traceparent) {
      headers["traceparent"] = traceparent;
    }

    const timerLabel = `stellar-rpc.${rpcRequest.method}`;
    const res = await withTimeout(fetch(rpcUrl, { method: "POST", headers, body }), timeoutMs, timerLabel);

    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`Stellar RPC returned non-JSON response: ${res.status}`), { status: res.status });
    }

    if (payload.error) {
      const err = new Error(payload.error.message || `Stellar RPC error: ${rpcRequest.method}`);
      err.code = payload.error.code;
      err.status = payload.error.code;
      throw err;
    }

    return payload.result;
  };

  try {
    return await rpcCircuitBreaker.call(async () => {
      return withRetry(exec, {
        idempotent: true,
        maxAttempts: DEFAULT_RETRIES,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        isTransientError: isRpcTransientError,
      });
    });
  } catch (error) {
    incrementCounter("rpc_errors_total", { operation: rpcRequest.method });
    throw error;
  }
}

/**
 * Simulate a Soroban contract transaction.
 */
export async function simulateTransaction(xdr, opts = {}) {
  return rpcCall({ method: "simulateTransaction", params: { transaction: xdr } }, opts);
}

/**
 * Fetch events from the Stellar RPC.
 *
 * @param {object} [query]
 * @param {string} [query.cursor] - Pagination cursor
 * @param {number} [query.limit] - Page size
 * @param {string} [query.startLedger] - Start ledger sequence
 * @param {Array<{contractIds?: string[], type?: string}>} [query.filters] - Event filters
 */
export async function getRpcEvents({ cursor, limit, startLedger, filters } = {}, opts = {}) {
  const params = {};
  if (startLedger) params.startLedger = startLedger;
  if (filters && filters.length > 0) params.filters = filters;
  if (cursor || limit) {
    params.pagination = {};
    if (cursor) params.pagination.cursor = cursor;
    if (limit) params.pagination.limit = limit;
  }
  return rpcCall({ method: "getEvents", params }, opts);
}

/**
 * Get RPC health status.
 */
export async function getRpcHealth(opts = {}) {
  return rpcCall({ method: "getHealth" }, opts);
}
