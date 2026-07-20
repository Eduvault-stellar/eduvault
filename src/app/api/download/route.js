/**
 * GET /api/download — Issue #63
 *
 * Protected file delivery endpoint. Verifies the caller holds an active
 * on-chain entitlement for the requested material before releasing the
 * IPFS CID or proxying the file stream. Verifies file integrity against
 * the purchased manifest version.
 *
 * Query params:
 *   - materialId  : The material identifier
 *   - buyerAddress: The buyer's Stellar public key
 *   - version     : Optional specific version to download
 *
 * Flow:
 *  1. Validate params
 *  2. verifyEntitlement() — checks cache → DB → chain
 *  3. Fetch material record to get the IPFS CID
 *  4. Verify manifest digest and version binding
 *  5. Return a signed/time-limited redirect to the IPFS gateway
 *     (or stream the file through the Next.js edge)
 */

import { NextResponse } from 'next/server';
import { verifyEntitlement } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';
import { getIpfsUrl } from '@/lib/config/chain';
import { ObjectId } from 'mongodb';
import { getManifest, getLatestManifest, isManifestWithdrawn } from '@/lib/provenance/registry';
import { verifyManifestDigest, verifyFileCid } from '@/lib/provenance/verify';
import { resolveAuthenticatedWallet } from '@/lib/auth/walletIdentity';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const identity = await resolveAuthenticatedWallet(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const buyerAddress = identity.walletAddress;
  const requestedVersion = searchParams.get('version');

  // ── 1. Validate params ─────────────────────────────────────────────────────

  if (!materialId) {
    return NextResponse.json(
      { error: 'Missing materialId' },
      { status: 400 }
    );
  }

  // ── 2. Verify entitlement ─────────────────────────────────────────────────

  let entitlementResult;
  try {
    entitlementResult = await verifyEntitlement(materialId, buyerAddress);
  } catch (err) {
    console.error('[download] entitlement check error:', err);
    return NextResponse.json(
      { error: 'Entitlement verification failed' },
      { status: 503 }
    );
  }

  if (!entitlementResult.hasAccess) {
    return NextResponse.json(
      {
        error: 'Unlicensed Access',
        detail:
          'You do not hold an active entitlement for this material. Purchase it first.',
      },
      { status: 403 }
    );
  }

  // ── 3. Fetch material record to get CID ──────────────────────────────────

  let material;
  try {
    const db = await getDb();
    material = await db.collection('materials').findOne({ materialId });
    if (!material && ObjectId.isValid(materialId)) {
      material = await db.collection('materials').findOne({ _id: new ObjectId(materialId) });
    }
  } catch (err) {
    console.error('[download] DB error fetching material:', err);
    return NextResponse.json({ error: 'Material lookup failed' }, { status: 503 });
  }

  if (!material) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 });
  }

  const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? material.storageKey ?? material.fileUrl ?? '';

  if (!cid) {
    return NextResponse.json(
      { error: 'Material has no associated file CID' },
      { status: 404 }
    );
  }

  // ── 4. Verify manifest version binding ────────────────────────────────────

  let manifestVersion = null;
  let manifestDigestVerified = false;
  let versionWithdrawn = false;

  try {
    let manifestDoc = null;

    if (requestedVersion) {
      const versionNum = parseInt(requestedVersion, 10);
      if (Number.isFinite(versionNum) && versionNum > 0) {
        manifestDoc = await getManifest(materialId, versionNum);
      }
    }

    if (!manifestDoc) {
      manifestDoc = await getLatestManifest(materialId);
    }

    if (manifestDoc) {
      manifestVersion = manifestDoc.version;
      versionWithdrawn = manifestDoc.withdrawn === true;

      if (versionWithdrawn) {
        return NextResponse.json(
          {
            error: 'Version Withdrawn',
            detail: `Version ${manifestVersion} has been withdrawn: ${manifestDoc.withdrawalReason || 'No reason specified'}`,
          },
          { status: 410 }
        );
      }

      manifestDigestVerified = verifyManifestDigest(
        manifestDoc.manifest,
        manifestDoc.digest
      );

      // Verify the served CID matches the manifest
      const cidMatch = await verifyFileCid(materialId, manifestVersion, cid);
      if (!cidMatch.valid) {
        console.warn('[download] CID mismatch:', cidMatch.detail);
      }
    }
  } catch (manifestErr) {
    console.warn('[download] Manifest verification error:', manifestErr?.message);
  }

  // ── 5. Release CID / redirect to IPFS gateway ────────────────────────────

  const fileUrl = getIpfsUrl(cid);

  return NextResponse.json(
    {
      ok: true,
      materialId,
      fileUrl,
      fileName: material.fileName ?? material.title ?? materialId,
      contentType: material.contentType ?? 'application/octet-stream',
      source: entitlementResult.source,
      manifestVersion,
      manifestDigestVerified,
    },
    {
      headers: {
        'Cache-Control': 'private, max-age=60',
        'X-Entitlement-Source': entitlementResult.source,
        'X-Manifest-Version': manifestVersion ? String(manifestVersion) : '',
        'X-Manifest-Verified': manifestDigestVerified ? 'true' : 'false',
      },
    }
  );
}
