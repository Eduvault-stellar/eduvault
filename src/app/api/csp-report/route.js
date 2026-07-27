import { logger } from "@/lib/logger";
import { normalizeCspReport, shouldRecordCspReport } from "@/lib/security/csp";
import { withApiHardening } from "@/lib/api/hardening";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_REPORT_BYTES = 16 * 1024;

export async function POST(request) {
  return withApiHardening(
    request,
    {
      route: "csp-report",
      // Public, unauthenticated ingestion endpoint — fail open so a Redis
      // outage never blocks browsers from delivering (best-effort) reports.
      rateLimit: { limit: 30, windowMs: 60_000, outagePolicy: "open" },
    },
    async () => {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > MAX_REPORT_BYTES) return new Response(null, { status: 413 });

      try {
        const text = await request.text();
        if (new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES) {
          return new Response(null, { status: 413 });
        }
        const parsed = JSON.parse(text);
        for (const payload of (Array.isArray(parsed) ? parsed : [parsed]).slice(0, 20)) {
          const report = normalizeCspReport(payload);
          if (shouldRecordCspReport(report)) {
            logger.warn({ event: "csp_violation", ...report }, "Browser CSP violation");
          }
        }
      } catch {
        // Reports are best-effort and never return parsing details.
      }

      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }
  );
}
