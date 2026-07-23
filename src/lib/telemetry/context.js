/**
 * Request/job context propagation for EduVault observability (#20).
 *
 * Uses Node's AsyncLocalStorage so a correlation ID + trace context set at
 * the top of a request or worker job is automatically available to every
 * function called underneath it — including the logger — without having
 * to pass it through every function signature.
 *
 * This is intentionally dependency-free so it works with zero installs.
 * Uses a simple random hex generator instead of node:crypto so it works
 * in both server and browser bundled environments.
 *
 * `node:async_hooks` is imported directly — next.config.mjs's webpack config
 * already maps it to `false` for client bundles (see the `resolve.fallback`
 * entry there), so `AsyncLocalStorage` below is simply `undefined` in the
 * browser and we fall back to a no-op store. (A previous version tried to
 * hide a `require("async_hooks")` call behind `eval` for the same reason,
 * but that silently produced the no-op store in *any* real ESM execution
 * too — including `node --test` and native ESM in production — not just the
 * browser, quietly breaking context propagation there.)
 */

import { AsyncLocalStorage } from "node:async_hooks";

let _storage = null;

function getStorage() {
  if (!_storage) {
    const Storage =
      AsyncLocalStorage ||
      class {
        getStore() { return null; }
        run(store, fn) { return fn(); }
      };
    _storage = new Storage();
  }
  return _storage;
}

function generateRandomHex(length) {
  let result = "";
  const hexChars = "0123456789abcdef";
  for (let i = 0; i < length; i++) {
    result += hexChars[Math.floor(Math.random() * 16)];
  }
  return result;
}

/**
 * Generate a W3C traceparent-shaped id pair so this is OpenTelemetry
 * compatible even without the @opentelemetry/api package installed.
 * Format reference: https://www.w3.org/TR/trace-context/
 */
export function generateTraceId() {
  return generateRandomHex(32); // 32 hex chars
}

export function generateSpanId() {
  return generateRandomHex(16); // 16 hex chars
}

export function buildTraceparent(traceId, spanId, sampled = true) {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

/**
 * Parse an incoming W3C traceparent header, if present.
 * Returns null if missing or malformed (never throws).
 */
export function parseTraceparent(header) {
  if (!header || typeof header !== "string") return null;
  const parts = header.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (version !== "00" || traceId.length !== 32 || spanId.length !== 16) return null;
  return { traceId, spanId, sampled: flags === "01" };
}

/**
 * Start a new context (call once per HTTP request or worker job).
 * If an incoming traceparent is provided, we continue that trace instead
 * of starting a new one — this is what lets traces cross the HTTP ->
 * background-worker boundary (acceptance criterion).
 */
export function runWithContext(fields, fn) {
  const incoming = parseTraceparent(fields.traceparent);
  const traceId = incoming?.traceId || generateTraceId();
  const spanId = generateSpanId();

  const ctx = {
    correlationId: fields.correlationId || generateRandomHex(32),
    traceId,
    spanId,
    parentSpanId: incoming?.spanId || null,
    route: fields.route || null,
    jobType: fields.jobType || null,
  };

  return getStorage().run(ctx, fn);
}

/** Read the current context, or null if called outside runWithContext. */
export function getContext() {
  return getStorage().getStore() || null;
}

/** Convenience: the traceparent header to forward to downstream calls/jobs. */
export function currentTraceparent() {
  const ctx = getContext();
  if (!ctx) return null;
  return buildTraceparent(ctx.traceId, ctx.spanId);
}

export function currentCorrelationId() {
  return getContext()?.correlationId || null;
}