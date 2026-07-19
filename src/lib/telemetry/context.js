/**
 * Request/job context propagation for EduVault observability (#20).
 *
 * Uses Node's AsyncLocalStorage so a correlation ID + trace context set at
 * the top of a request or worker job is automatically available to every
 * function called underneath it — including the logger — without having
 * to pass it through every function signature.
 *
 * This is intentionally dependency-free so it works with zero installs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage();

/**
 * Generate a W3C traceparent-shaped id pair so this is OpenTelemetry
 * compatible even without the @opentelemetry/api package installed.
 * Format reference: https://www.w3.org/TR/trace-context/
 */
export function generateTraceId() {
  return randomUUID().replace(/-/g, ""); // 32 hex chars
}

export function generateSpanId() {
  return randomUUID().replace(/-/g, "").slice(0, 16); // 16 hex chars
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
    correlationId: fields.correlationId || randomUUID(),
    traceId,
    spanId,
    parentSpanId: incoming?.spanId || null,
    route: fields.route || null,
    jobType: fields.jobType || null,
  };

  return storage.run(ctx, fn);
}

/** Read the current context, or null if called outside runWithContext. */
export function getContext() {
  return storage.getStore() || null;
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