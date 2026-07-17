import { NextResponse } from "next/server";
import { auditLog } from "./audit";
import { checkRateLimit } from "./rateLimit";
import { ValidationError } from "./validation";
import { captureException } from "@/lib/sentry";
import { runWithContext, currentTraceparent, currentCorrelationId } from "@/lib/telemetry/context";
import { withSpan } from "@/lib/telemetry/tracing";
import { incrementCounter, recordHistogram } from "@/lib/telemetry/metrics";

function clientKey(request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

export async function withApiHardening(request, options, handler) {
  const route = options.route;
  const method = request.method || "GET";

  return runWithContext(
    {
      correlationId: request.headers.get("x-correlation-id") || undefined,
      traceparent: request.headers.get("traceparent") || undefined,
      route,
    },
    async () => {
      const rateLimit = checkRateLimit(`${route}:${method}:${clientKey(request)}`, options.rateLimit);

      if (!rateLimit.allowed) {
        auditLog({ event: "rate_limit_blocked", route, method, status: 429 });
        incrementCounter("http_requests_total", { route, method, outcome: "rate_limited" });
        return NextResponse.json(
          { error: "Too many requests", retryAfter: rateLimit.retryAfter },
          {
            status: 429,
            headers: { "x-correlation-id": currentCorrelationId() },
          }
        );
      }

      const startedAt = Date.now();

      try {
        const response = await withSpan("http.request", { route, method }, async (span) => {
          const result = await handler();
          span.setAttribute("http.status_code", result?.status || 200);
          return result;
        });

        recordHistogram("http_request_duration_ms", { route, method }, Date.now() - startedAt);
        incrementCounter("http_requests_total", { route, method, outcome: "success" });

        // Propagate correlation id back to the caller so it can be logged
        // client-side too, and carried forward if the caller calls another
        // EduVault service (acceptance criterion: crosses HTTP boundary).
        response.headers.set("x-correlation-id", currentCorrelationId());
        response.headers.set("traceparent", currentTraceparent());
        return response;
      } catch (error) {
        recordHistogram("http_request_duration_ms", { route, method }, Date.now() - startedAt);

        if (error instanceof ValidationError) {
          auditLog({ event: "validation_failed", route, method, status: 400, reason: error.message });
          incrementCounter("http_requests_total", { route, method, outcome: "validation_error" });
          const res = NextResponse.json({ error: error.message, details: error.details }, { status: 400 });
          res.headers.set("x-correlation-id", currentCorrelationId());
          return res;
        }

        incrementCounter("http_requests_total", { route, method, outcome: "error" });
        captureException(error, { route, method, correlationId: currentCorrelationId() });
        throw error;
      }
    }
  );
}