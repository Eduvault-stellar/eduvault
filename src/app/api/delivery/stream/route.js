/**
 * GET /api/delivery/stream
 *
 * Authenticated streaming proxy for protected content.
 *
 * Query params:
 *   - token       : Short-lived delivery token from POST /api/delivery/token
 *   - materialId  : The material to stream
 *
 * Headers (optional):
 *   - Range       : RFC 7233 byte range for partial content / resume
 *
 * This endpoint:
 *   - Verifies the delivery token (expiry, audience, optional nonce)
 *   - Resolves the material CID and verifies it against the purchased
 *     version manifest (provenance digest + CID binding) before serving any
 *     bytes — a mutable or tampered CID mapping is never trusted (Issue #168)
 *   - Proxies the file stream from the IPFS gateway through the server
 *   - Supports backpressure, cancellation, range requests, and timeouts
 *   - Records audit events for every delivery
 *   - Never exposes the permanent CID or gateway URL to the client
 */

import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import { verifyDeliveryToken } from '@/lib/delivery/token';
import {
  createUpstreamStream,
  parseRangeHeader,
  resolveVerifiedDeliverable,
} from '@/lib/delivery/stream';
import { recordDeliveryAudit } from '@/lib/delivery/audit';
import { errorResponse } from '@/lib/utils/errorResponse';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  return withApiHardening(
    request,
    {
      route: 'delivery-stream',
      rateLimit: {
        limit: 100,
        windowMs: 60_000, // 100 stream requests/min per IP
      },
    },
    async ({ disconnectSignal }) => {
      const startedAt = Date.now();
      const { searchParams } = new URL(request.url);
      const token = searchParams.get('token') ?? '';
      const materialId = searchParams.get('materialId') ?? '';

      // ── 1. Validate params ──────────────────────────────────────────────
      if (!token || !materialId) {
        await recordDeliveryAudit({
          event: 'delivery_stream_denied',
          result: 'missing_params',
          statusCode: 400,
        });
        return errorResponse({ status: 400, detail: 'token and materialId are required' });
      }

      // ── 2. Verify delivery token ────────────────────────────────────────
      const clientIp =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        null;

      const verification = await verifyDeliveryToken(token, {
        expectedMaterial: materialId,
        clientIp: process.env.DELIVERY_IP_BINDING === 'true' ? clientIp : null,
      });

      if (!verification.valid) {
        await recordDeliveryAudit({
          event: 'delivery_stream_denied',
          materialId,
          result: 'invalid_token',
          errorReason: verification.reason,
          statusCode: 401,
          clientIp,
          durationMs: Date.now() - startedAt,
        });

        const statusCode = verification.reason === 'token_expired' ? 410 : 401;
        return errorResponse({
          status: statusCode,
          detail:
            verification.reason === 'token_expired'
              ? 'Delivery token has expired. Request a new one.'
              : 'Invalid delivery token.',
        });
      }

      const buyerAddress = verification.payload.ba;

      // ── 3. Resolve material + verify provenance integrity ───────────────
      // The CID is verified against the purchased version manifest (digest +
      // CID binding) BEFORE any bytes are served. Failures are hard denials.
      const deliverable = await resolveVerifiedDeliverable({ materialId, buyerAddress });

      if (deliverable.error) {
        await recordDeliveryAudit({
          event: 'delivery_stream_denied',
          actor: verification.payload?.ba,
          buyerAddress,
          materialId,
          result: 'integrity_denied',
          errorReason: deliverable.error.reason,
          statusCode: deliverable.error.statusCode,
          durationMs: Date.now() - startedAt,
          clientIp,
          userAgent: request.headers.get('user-agent') || null,
        });
        return errorResponse({
          status: deliverable.error.statusCode,
          detail: deliverable.error.detail,
        });
      }

      const { material, version } = deliverable;

      // ── 4. Parse range header ───────────────────────────────────────────
      const rangeHeader = request.headers.get('range');
      const range = parseRangeHeader(rangeHeader);

      // ── 5. Create upstream stream (client disconnect via hardening) ─────
      const upstreamStream = createUpstreamStream({
        cid: material.cid,
        fileSize: material.fileSize,
        range,
        signal: disconnectSignal,
      });

      // ── 6. Build response headers ───────────────────────────────────────
      const headers = {
        'Content-Type': material.contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(material.fileName)}"`,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Accept-Ranges': 'bytes',
        'X-Manifest-Version': String(version ?? ''),
        'X-Manifest-Verified': 'true',
      };

      let statusCode = 200;

      if (range) {
        statusCode = 206;
        const contentStart = range.start;
        const contentEnd =
          range.end !== Infinity
            ? range.end
            : material.fileSize > 0
              ? material.fileSize - 1
              : 0;
        const contentLength = contentEnd - contentStart + 1;
        headers['Content-Range'] = `bytes ${contentStart}-${contentEnd}/${material.fileSize || contentLength}`;
        headers['Content-Length'] = String(contentLength);
      } else if (material.fileSize > 0) {
        headers['Content-Length'] = String(material.fileSize);
      }

      // ── 7. Audit the stream start (non-blocking) ────────────────────────
      recordDeliveryAudit({
        event: 'delivery_stream_started',
        actor: verification.payload?.ba,
        buyerAddress,
        materialId,
        bytesRequested: range
          ? range.end === Infinity
            ? null
            : range.end - range.start + 1
          : material.fileSize || null,
        rangeStart: range?.start ?? null,
        rangeEnd: range?.end ?? null,
        result: 'started',
        statusCode,
        durationMs: Date.now() - startedAt,
        clientIp,
        userAgent: request.headers.get('user-agent') || null,
      }).catch(() => {}); // Non-blocking

      // ── 8. Return streamed response ─────────────────────────────────────
      return new NextResponse(upstreamStream, {
        status: statusCode,
        headers,
      });
    }
  );
}
