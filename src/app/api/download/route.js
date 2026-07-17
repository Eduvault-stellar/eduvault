/**
 * GET /api/download — Issue #63 (Refactored for authenticated streaming)
 *
 * Protected file delivery endpoint. Verifies the caller holds an active
 * on-chain entitlement for the requested material, then issues a short-lived
 * delivery token instead of exposing the raw IPFS CID or gateway URL.
 *
 * Query params:
 *   - materialId  : The material identifier
 *   - buyerAddress: The buyer's Stellar public key
 *
 * Flow:
 *  1. Validate params
 *  2. verifyEntitlement() — checks cache → DB → chain
 *  3. Fetch material record to get metadata (CID stays server-side)
 *  4. Issue a short-lived delivery token bound to the buyer + material
 *  5. Return the token + metadata (no CID, no gateway URL)
 *
 * Security: The returned token is HMAC-signed, time-limited (15 min),
 * and audience-bound. It cannot be replayed by another user or after expiry.
 * The permanent CID is never exposed to the client.
 */

import { NextResponse } from 'next/server';
import { verifyEntitlement } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { issueDeliveryToken } from '@/lib/delivery/token';
import { recordDeliveryAudit } from '@/lib/delivery/audit';
import { normalizeBuyerAddress } from '@/lib/purchases/access';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const buyerAddress = searchParams.get('buyerAddress') ?? '';

  const startedAt = Date.now();

  // ── 1. Validate params ─────────────────────────────────────────────────────

  if (!materialId || !buyerAddress) {
    return NextResponse.json(
      { error: 'Missing materialId or buyerAddress' },
      { status: 400 }
    );
  }

  const normalizedAddress = normalizeBuyerAddress(buyerAddress);

  // ── 2. Verify entitlement ─────────────────────────────────────────────────

  let entitlementResult;
  try {
    entitlementResult = await verifyEntitlement(materialId, normalizedAddress);
  } catch (err) {
    console.error('[download] entitlement check error:', err);
    await recordDeliveryAudit({
      event: 'delivery_token_denied',
      buyerAddress: normalizedAddress,
      materialId,
      result: 'entitlement_error',
      errorReason: err.message,
      statusCode: 503,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      { error: 'Entitlement verification failed' },
      { status: 503 }
    );
  }

  if (!entitlementResult.hasAccess) {
    await recordDeliveryAudit({
      event: 'delivery_token_denied',
      buyerAddress: normalizedAddress,
      materialId,
      result: 'no_entitlement',
      statusCode: 403,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      {
        error: 'Unlicensed Access',
        detail:
          'You do not hold an active entitlement for this material. Purchase it first.',
      },
      { status: 403 }
    );
  }

  // ── 3. Fetch material record to get metadata ──────────────────────────────

  let material;
  try {
    const db = await getDb();
    material = await db.collection('materials').findOne({ materialId });
    if (!material && ObjectId.isValid(materialId)) {
      material = await db
        .collection('materials')
        .findOne({ _id: new ObjectId(materialId) });
    }
  } catch (err) {
    console.error('[download] DB error fetching material:', err);
    return NextResponse.json(
      { error: 'Material lookup failed' },
      { status: 503 }
    );
  }

  if (!material) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 });
  }

  const cid =
    material.ipfsCid ??
    material.cid ??
    material.fileHash ??
    material.storageKey ??
    material.fileUrl ??
    '';

  if (!cid) {
    return NextResponse.json(
      { error: 'Material has no associated file CID' },
      { status: 404 }
    );
  }

  // ── 4. Issue short-lived delivery token (instead of returning CID) ────────

  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null;

  let tokenResult;
  try {
    tokenResult = await issueDeliveryToken({
      buyerAddress: normalizedAddress,
      materialId,
      ttlSeconds: 15 * 60, // 15 minutes
      singleUse: false,
      ipRestriction: null,
    });
  } catch (err) {
    console.error('[download] token issuance error:', err);
    return NextResponse.json(
      { error: 'Failed to issue delivery token' },
      { status: 503 }
    );
  }

  // ── 5. Audit ──────────────────────────────────────────────────────────────

  await recordDeliveryAudit({
    event: 'delivery_token_issued',
    buyerAddress: normalizedAddress,
    materialId,
    result: 'success',
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    clientIp,
  });

  // ── 6. Return token + metadata (NO CID, NO gateway URL) ───────────────────

  return NextResponse.json(
    {
      ok: true,
      materialId,
      // Instead of fileUrl (which exposed the CID/gateway), return:
      deliveryToken: tokenResult.token,
      expiresAt: tokenResult.expiresAt,
      streamEndpoint: '/api/delivery/stream',
      fileName: material.fileName ?? material.title ?? materialId,
      contentType: material.contentType ?? 'application/octet-stream',
      fileSize: material.fileSize || 0,
      source: entitlementResult.source,
    },
    {
      headers: {
        // No caching — every download requires a fresh token
        'Cache-Control': 'private, no-store',
        'X-Entitlement-Source': entitlementResult.source,
        'X-Token-Expires': String(tokenResult.expiresAt),
      },
    }
  );
}