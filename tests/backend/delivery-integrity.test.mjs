/**
 * Delivery Integrity Tests — Issue #168
 *
 * Regression: protected delivery must verify fetched bytes against the
 * purchased version manifest instead of trusting the mutable CID mapping on
 * the materials record.
 *
 * Before this fix, GET /api/delivery/stream resolved the CID straight off the
 * `materials` record (getMaterialRecord) and proxied bytes from that CID with
 * no provenance check — so a tampered or drifted `ipfsCid` would silently
 * serve a paying buyer different bytes than the version they purchased.
 *
 * These tests exercise the real verification logic in
 * src/lib/provenance/deliveryIntegrity.js (pure, dependency-injected) and
 * cover: mutable-CID substitution, stale/duplicated versions, withdrawn
 * manifests, digest tampering, anchor mismatch, missing manifests/CIDs,
 * legacy unbound purchases, and partial-failure inputs.
 *
 * Run with: npm run test:backend
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createHash } from 'node:crypto';

import { buildAndDigest, digestManifest } from '../../src/lib/provenance/manifest.js';
import { verifyDeliveryIntegrityLogic, DELIVERY_INTEGRITY } from '../../src/lib/provenance/deliveryIntegrity.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BUYER = 'GCAPKDX5XHB6H5G4C6Q5XH5G4C6Q5XH5G4C6Q5XH5G4C6Q5XH5G4C6Q'.toLowerCase();
const CREATOR = 'GALICE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function makeManifestDoc({ materialId, version, cid, hash, withdrawn = false, createdAt = '2026-01-15T12:00:00.000Z' }) {
  const { manifest, digest } = buildAndDigest({
    materialId,
    version,
    previousVersionDigest: version > 1 ? `prev-digest-${version - 1}` : null,
    creator: CREATOR,
    createdAt,
    file: {
      cid,
      hash: hash || createHash('sha256').update(`${materialId}:${version}:${cid}`).digest('hex'),
      size: 1024,
      type: 'application/pdf',
    },
  });

  return { materialId, version, digest, manifest, creator: CREATOR, createdAt: new Date(createdAt), verified: true, withdrawn };
}

function makePurchase({ materialId = 'mat-001', buyerAddress = BUYER, status = 'confirmed', purchasedVersion = 1, versionBinding = null }) {
  return {
    materialId,
    buyerAddress,
    status,
    purchasedVersion,
    versionBinding,
    createdAt: new Date('2026-01-16T00:00:00.000Z'),
    updatedAt: new Date('2026-01-16T00:00:00.000Z'),
  };
}

function createDeps({ purchase = null, manifests = [], anchors = [] }) {
  const byKey = new Map(manifests.map((doc) => [`${doc.materialId}:${doc.version}`, doc]));
  const latestByMaterial = new Map();
  for (const doc of manifests) {
    const current = latestByMaterial.get(doc.materialId);
    if (!current || doc.version > current.version) latestByMaterial.set(doc.materialId, doc);
  }

  return {
    getPurchase: async ({ materialId, buyerAddress }) => {
      if (!purchase) return null;
      return purchase.materialId === materialId && purchase.buyerAddress === buyerAddress.toLowerCase() ? purchase : null;
    },
    getManifest: async (materialId, version) => byKey.get(`${materialId}:${version}`) ?? null,
    getLatestManifest: async (materialId) => latestByMaterial.get(materialId) ?? null,
    getDigestAnchor: async (materialId, version) =>
      anchors.find((a) => a.materialId === materialId && a.version === version) ?? null,
  };
}

function buildIntegrity({ materialId = 'mat-001', buyerAddress = BUYER, requestedCid, version = null, ...deps }) {
  return verifyDeliveryIntegrityLogic({ materialId, buyerAddress, requestedCid, version, ...deps });
}

// ── Regression reproduction: the pre-fix route trusted the mutable CID ───────

describe('Issue #168 regression — mutable CID mapping is never trusted', () => {
  test('pre-fix delivery logic served bytes from whatever CID the materials record held', async () => {
    // The OLD route: resolve CID from the materials record, stream it, no
    // manifest verification. This is what made the vulnerability possible.
    function oldRouteDecision(materialRecord) {
      const cid =
        materialRecord.ipfsCid ??
        materialRecord.cid ??
        materialRecord.fileHash ??
        materialRecord.storageKey ??
        materialRecord.fileUrl ??
        '';
      if (!cid) return { served: false, reason: 'no_cid' };
      return { served: true, cid }; // Bytes proxied from this CID, unverified
    }

    // Buyer purchased version 1 whose manifest pins CID-A.
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmPurchasedBytes' });

    // An attacker (or drift) rewrites the materials record to point at CID-B.
    const tamperedRecord = { materialId: 'mat-001', ipfsCid: 'QmEvilReplacement' };

    const oldDecision = oldRouteDecision(tamperedRecord);
    assert.equal(oldDecision.served, true, 'old logic would serve the tampered CID');
    assert.equal(oldDecision.cid, 'QmEvilReplacement');
    assert.notEqual(oldDecision.cid, manifestV1.manifest.file.cid, 'served CID differs from purchased manifest CID');

    // The new gate must refuse to serve CID-B for this buyer.
    const result = await buildIntegrity({
      requestedCid: 'QmEvilReplacement',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false, 'tampered CID must be denied');
    assert.equal(result.reason, DELIVERY_INTEGRITY.CID_MISMATCH);
    assert.equal(result.statusCode, 409);
  });
});

// ── Success paths ─────────────────────────────────────────────────────────────

describe('verifyDeliveryIntegrity — success', () => {
  test('serves bytes when the material CID matches the purchased version manifest', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, true);
    assert.equal(result.reason, DELIVERY_INTEGRITY.OK);
    assert.equal(result.statusCode, 200);
    assert.equal(result.version, 1);
    assert.equal(result.manifestCid, 'QmGood');
  });

  test('legacy purchase without a version binding resolves the latest verified manifest', async () => {
    const manifestV2 = makeManifestDoc({ materialId: 'mat-001', version: 2, cid: 'QmLatest' });

    const result = await buildIntegrity({
      requestedCid: 'QmLatest',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: null }),
        manifests: [manifestV2],
      }),
    });

    assert.equal(result.valid, true);
    assert.equal(result.version, 2);
    assert.equal(result.manifestCid, 'QmLatest');
  });

  test('explicit version matching the purchase binding is accepted', async () => {
    const manifestV3 = makeManifestDoc({ materialId: 'mat-001', version: 3, cid: 'QmV3' });

    const result = await buildIntegrity({
      requestedCid: 'QmV3',
      version: 3,
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 3 }),
        manifests: [manifestV3],
      }),
    });

    assert.equal(result.valid, true);
    assert.equal(result.version, 3);
  });

  test('a matching on-chain anchor does not block delivery', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
        anchors: [{ materialId: 'mat-001', version: 1, digest: manifestV1.digest, verified: true }],
      }),
    });

    assert.equal(result.valid, true);
  });
});

// ── Failure paths: invalid / stale / duplicated / concurrent / partial ───────

describe('verifyDeliveryIntegrity — failure paths', () => {
  test('denies when the material CID was swapped to different bytes (mutable mapping)', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmPurchased' });

    const result = await buildIntegrity({
      requestedCid: 'QmSwapped',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.CID_MISMATCH);
    assert.equal(result.statusCode, 409);
  });

  test('denies when the purchase version manifest is missing', async () => {
    const result = await buildIntegrity({
      requestedCid: 'QmAnything',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 5 }),
        manifests: [],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.MANIFEST_NOT_FOUND);
    assert.equal(result.statusCode, 404);
  });

  test('denies when the resolved manifest is withdrawn (concurrent recall)', async () => {
    const manifestV1 = makeManifestDoc({
      materialId: 'mat-001',
      version: 1,
      cid: 'QmGood',
      withdrawn: true,
    });

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.VERSION_WITHDRAWN);
    assert.equal(result.statusCode, 410);
  });

  test('denies when the manifest digest no longer matches its stored digest (tamper)', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });
    // Simulate an in-place mutation of the manifest after storage.
    manifestV1.manifest.metadata = { title: 'Tampered' };

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.DIGEST_MISMATCH);
    assert.equal(result.statusCode, 409);
  });

  test('denies when the on-chain anchor digest disagrees with the manifest', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
        anchors: [{ materialId: 'mat-001', version: 1, digest: '0'.repeat(64), verified: true }],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.ANCHOR_MISMATCH);
    assert.equal(result.statusCode, 409);
  });

  test('denies when the manifest records no file CID (partial/incomplete data)', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });
    // Simulate a manifest stored without a file CID, with a self-consistent
    // digest so the check under test is the missing-CID guard, not the digest.
    delete manifestV1.manifest.file.cid;
    manifestV1.digest = digestManifest(manifestV1.manifest);

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.MISSING_CID);
    assert.equal(result.statusCode, 409);
  });

  test('denies when no purchase record exists', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({ purchase: null, manifests: [manifestV1] }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.PURCHASE_NOT_FOUND);
    assert.equal(result.statusCode, 403);
  });

  test('denies when the purchase is not in a completed state', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ status: 'pending', purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.PURCHASE_NOT_COMPLETED);
    assert.equal(result.statusCode, 403);
  });

  test('denies a requested version that is stale relative to the purchase binding', async () => {
    const manifestV2 = makeManifestDoc({ materialId: 'mat-001', version: 2, cid: 'QmV2' });

    const result = await buildIntegrity({
      requestedCid: 'QmV2',
      version: 2,
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV2],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.STALE_VERSION);
    assert.equal(result.statusCode, 409);
  });

  test('serves the bound version even when a newer manifest exists (version pinning)', async () => {
    // Buyer purchased v1 (CID-A). v2 (CID-B) is now latest. The materials
    // record still points at CID-A → v1 must be served, not v2.
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmBoundV1' });
    const manifestV2 = makeManifestDoc({ materialId: 'mat-001', version: 2, cid: 'QmNewerV2' });

    const result = await buildIntegrity({
      requestedCid: 'QmBoundV1',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1, manifestV2],
      }),
    });

    assert.equal(result.valid, true);
    assert.equal(result.version, 1);
    assert.equal(result.manifestCid, 'QmBoundV1');
  });

  test('denies when the materials record drifted to the newer CID but the buyer owns v1', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmBoundV1' });
    const manifestV2 = makeManifestDoc({ materialId: 'mat-001', version: 2, cid: 'QmNewerV2' });

    const result = await buildIntegrity({
      requestedCid: 'QmNewerV2', // materials record now points at v2's bytes
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1, manifestV2],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.CID_MISMATCH);
  });

  test('denies missing required parameters (partial-failure input)', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });
    const deps = createDeps({ purchase: makePurchase({ purchasedVersion: 1 }), manifests: [manifestV1] });

    const noCid = await buildIntegrity({ requestedCid: null, ...deps });
    assert.equal(noCid.valid, false);
    assert.equal(noCid.reason, DELIVERY_INTEGRITY.MISSING_PARAMS);

    const noBuyer = await buildIntegrity({ requestedCid: 'QmGood', buyerAddress: '', ...deps });
    assert.equal(noBuyer.valid, false);
    assert.equal(noBuyer.reason, DELIVERY_INTEGRITY.MISSING_PARAMS);
  });

  test('throws when required dependencies are missing (programmer error)', async () => {
    await assert.rejects(
      () =>
        verifyDeliveryIntegrityLogic({
          materialId: 'mat-001',
          buyerAddress: BUYER,
          requestedCid: 'QmGood',
          getPurchase: async () => null,
        }),
      /getManifest/
    );
  });
});

// ── Boundary: manifest digest edge cases ──────────────────────────────────────

describe('verifyDeliveryIntegrity — digest boundaries', () => {
  test('denies a manifest whose stored digest is empty or missing', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });
    delete manifestV1.digest;

    const result = await buildIntegrity({
      requestedCid: 'QmGood',
      ...createDeps({
        purchase: makePurchase({ purchasedVersion: 1 }),
        manifests: [manifestV1],
      }),
    });

    assert.equal(result.valid, false);
    assert.equal(result.reason, DELIVERY_INTEGRITY.DIGEST_MISMATCH);
  });

  test('is case-insensitive for buyer address lookup', async () => {
    const manifestV1 = makeManifestDoc({ materialId: 'mat-001', version: 1, cid: 'QmGood' });
    const purchase = makePurchase({ purchasedVersion: 1, buyerAddress: BUYER });

    const result = await verifyDeliveryIntegrityLogic({
      materialId: 'mat-001',
      buyerAddress: BUYER.toUpperCase(), // mixed case input
      requestedCid: 'QmGood',
      getPurchase: async ({ buyerAddress: b }) =>
        purchase.buyerAddress === b.toLowerCase() ? purchase : null,
      getManifest: async () => manifestV1,
      getLatestManifest: async () => manifestV1,
    });

    assert.equal(result.valid, true);
  });
});
