import { verifyManifestDigest } from './manifest.js';

/**
 * Delivery integrity verification — Issue #168.
 *
 * Protected delivery must verify the bytes it is about to serve against the
 * purchased version manifest rather than trust the mutable CID mapping on the
 * `materials` record. A tampered or drifted `materials.ipfsCid` must never
 * redirect a paying buyer to different bytes.
 *
 * This module is deliberately pure: every database read is injected so the
 * logic can be unit-tested without a database or the `@/` path alias. The
 * production wiring lives in `src/lib/provenance/verify.js`.
 */

export const DELIVERY_INTEGRITY = Object.freeze({
  OK: 'ok',
  MISSING_PARAMS: 'missing_params',
  PURCHASE_NOT_FOUND: 'purchase_not_found',
  PURCHASE_NOT_COMPLETED: 'purchase_not_completed',
  STALE_VERSION: 'stale_version',
  MANIFEST_NOT_FOUND: 'manifest_not_found',
  VERSION_WITHDRAWN: 'version_withdrawn',
  DIGEST_MISMATCH: 'manifest_digest_mismatch',
  ANCHOR_MISMATCH: 'anchor_digest_mismatch',
  MISSING_CID: 'manifest_missing_cid',
  CID_MISMATCH: 'cid_mismatch',
});

const COMPLETED_STATUSES = ['confirmed', 'settled', 'completed'];

function failure(statusCode, reason, detail) {
  return { valid: false, statusCode, reason, detail, version: null, manifestCid: null };
}

/**
 * Core delivery integrity check (dependency-injectable for tests).
 *
 * Order of checks (fail-closed at the first violation):
 *   1. The buyer must hold a completed purchase for this material.
 *   2. Resolve the exact version to serve: explicit `version` > purchase
 *      binding (`purchasedVersion` / `versionBinding.version`) > latest
 *      manifest (legacy purchases without a binding).
 *   3. The manifest must exist and must not be withdrawn.
 *   4. The manifest must reproduce its stored digest (tamper detection).
 *   5. If the digest was anchored on-chain, it must agree with the anchor.
 *   6. The CID about to be served must equal the manifest's `file.cid`.
 *
 * @param {object} params
 * @param {string} params.materialId
 * @param {string} params.buyerAddress - Buyer wallet address (case-insensitive)
 * @param {string} params.requestedCid - The CID resolved from the (mutable) material record
 * @param {number|null} [params.version] - Explicitly requested version, if any
 * @param {(query: {materialId: string, buyerAddress: string}) => Promise<object|null>} params.getPurchase
 * @param {(materialId: string, version: number) => Promise<object|null>} params.getManifest
 * @param {(materialId: string) => Promise<object|null>} params.getLatestManifest
 * @param {(materialId: string, version: number) => Promise<object|null>} [params.getDigestAnchor]
 * @returns {Promise<{valid: boolean, statusCode: number, reason: string, detail: string, version: number|null, manifestCid: string|null}>}
 */
export async function verifyDeliveryIntegrityLogic({
  materialId,
  buyerAddress,
  requestedCid,
  version = null,
  getPurchase,
  getManifest,
  getLatestManifest,
  getDigestAnchor,
}) {
  if (!materialId || !buyerAddress || !requestedCid) {
    return failure(
      400,
      DELIVERY_INTEGRITY.MISSING_PARAMS,
      'materialId, buyerAddress and requestedCid are required',
    );
  }

  if (
    typeof getPurchase !== 'function' ||
    typeof getManifest !== 'function' ||
    typeof getLatestManifest !== 'function'
  ) {
    throw new TypeError(
      'deliveryIntegrity: getPurchase, getManifest and getLatestManifest are required',
    );
  }

  // 1. The buyer must hold a completed purchase for this material.
  const purchase = await getPurchase({ materialId, buyerAddress });
  if (!purchase) {
    return failure(
      403,
      DELIVERY_INTEGRITY.PURCHASE_NOT_FOUND,
      'No purchase record found for this buyer and material',
    );
  }

  const purchaseStatus = String(purchase.status || '').toLowerCase();
  if (!COMPLETED_STATUSES.includes(purchaseStatus)) {
    return failure(
      403,
      DELIVERY_INTEGRITY.PURCHASE_NOT_COMPLETED,
      `Purchase status "${purchase.status}" does not grant download access`,
    );
  }

  // 2. Resolve the exact version to serve.
  const boundVersion =
    purchase.purchasedVersion ?? purchase.versionBinding?.version ?? null;

  if (version != null && boundVersion != null && version !== boundVersion) {
    return failure(
      409,
      DELIVERY_INTEGRITY.STALE_VERSION,
      `Purchase is bound to version ${boundVersion}, but version ${version} was requested`,
    );
  }

  let manifestDoc;
  let manifestVersion = version ?? boundVersion;

  if (manifestVersion != null) {
    manifestDoc = await getManifest(materialId, manifestVersion);
    if (!manifestDoc) {
      return failure(
        404,
        DELIVERY_INTEGRITY.MANIFEST_NOT_FOUND,
        `No manifest found for material ${materialId} version ${manifestVersion}`,
      );
    }
  } else {
    // Legacy purchase without a version binding: fall back to the latest
    // verified manifest. Compatibility behavior for pre-binding purchases.
    manifestDoc = await getLatestManifest(materialId);
    if (!manifestDoc) {
      return failure(
        404,
        DELIVERY_INTEGRITY.MANIFEST_NOT_FOUND,
        `No manifest found for material ${materialId}`,
      );
    }
    manifestVersion = manifestDoc.version;
  }

  // 3. Withdrawn versions must never be served.
  if (manifestDoc.withdrawn === true) {
    return failure(
      410,
      DELIVERY_INTEGRITY.VERSION_WITHDRAWN,
      `Version ${manifestVersion} has been withdrawn and can no longer be delivered`,
    );
  }

  // 4. The manifest must reproduce its stored digest.
  if (!verifyManifestDigest(manifestDoc.manifest, manifestDoc.digest)) {
    return failure(
      409,
      DELIVERY_INTEGRITY.DIGEST_MISMATCH,
      'Manifest digest does not match stored digest — manifest may have been tampered with',
    );
  }

  // 5. If the digest was anchored on-chain, it must agree with the anchor.
  if (typeof getDigestAnchor === 'function') {
    const anchor = await getDigestAnchor(materialId, manifestVersion);
    if (anchor && anchor.digest && anchor.digest !== manifestDoc.digest) {
      return failure(
        409,
        DELIVERY_INTEGRITY.ANCHOR_MISMATCH,
        'Manifest digest does not match the on-chain digest anchor',
      );
    }
  }

  // 6. The bytes to be served must be the bytes the buyer purchased.
  const manifestCid = manifestDoc.manifest?.file?.cid;
  if (!manifestCid) {
    return failure(
      409,
      DELIVERY_INTEGRITY.MISSING_CID,
      'Manifest does not record a file CID for this version',
    );
  }

  if (manifestCid !== requestedCid) {
    return failure(
      409,
      DELIVERY_INTEGRITY.CID_MISMATCH,
      'Served content does not match the purchased version manifest',
    );
  }

  return {
    valid: true,
    statusCode: 200,
    reason: DELIVERY_INTEGRITY.OK,
    detail: 'Delivery verified against purchased version manifest',
    version: manifestVersion,
    manifestCid,
  };
}
