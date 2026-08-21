export const dynamic = "force-dynamic";

import { toPrometheusFormat } from "../../../lib/telemetry/metrics.js";
import { errorResponse } from "../../../lib/utils/errorResponse.js";

function getMetricsSecret() {
  return (
    process.env.METRICS_COLLECTOR_SECRET ||
    process.env.METRICS_SECRET ||
    ""
  );
}

export function isCollectorAuthorized(request) {
  const secret = getMetricsSecret();
  if (!secret) return true;

  const authHeader = request?.headers?.get?.("authorization") ?? "";
  if (authHeader === `Bearer ${secret}`) return true;

  const metricsHeader =
    request?.headers?.get?.("x-metrics-secret") ??
    request?.headers?.get?.("x-collector-secret") ??
    "";
  if (metricsHeader === secret) return true;

  return false;
}

/**
 * Prometheus-compatible metrics endpoint (#20).
 *
 * Scrapers hit this endpoint on a tight interval. Access is governed by
 * METRICS_COLLECTOR_SECRET or METRICS_SECRET when configured, returning 401
 * for unauthorized collectors.
 */
export async function GET(request) {
  if (request && !isCollectorAuthorized(request)) {
    return errorResponse({
      status: 401,
      title: "Unauthorized",
      detail: "Invalid or missing metrics collector authorization token.",
    });
  }

  const body = toPrometheusFormat();
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4" },
  });
}