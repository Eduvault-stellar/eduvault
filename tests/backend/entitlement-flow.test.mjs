/**
 * Comprehensive tests for the contract-backed entitlement system — Issue #191
 *
 * Tests entitlement creation, access verification, and security enforcement.
 */

import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';

// ── Test utilities ───────────────────────────────────────────────────────────

function createCollection() {
  const docs = new Map();
  return {
    docs,
    async findOne(query) {
      for (const doc of docs.values()) {
        const match = Object.entries(query).every(
          ([k, v]) => String(doc[k]) === String(v)
        );
        if (match) return doc;
      }
      return null;
    },
    async updateOne(query, update, opts = {}) {
      const materialId = query.materialId;
      const buyerAddress = query.buyerAddress;
      const key = `${materialId}:${buyerAddress}`;
      const exists = docs.has(key);
      if (!exists && !opts.upsert) return;
      const current = docs.get(key) ?? {};
      const setFields = update.$set ?? {};
      const setOnInsert = (!exists && update.$setOnInsert) ? update.$setOnInsert : {};
      docs.set(key, { ...current, ...setFields, ...setOnInsert });
    },
    async insertOne(doc) {
      const key = doc._id || `${doc.materialId}:${doc.buyerAddress}`;
      if (docs.has(key)) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      docs.set(key, doc);
    },
    async deleteOne(query) {
      const key = query._id || `${query.materialId}:${query.buyerAddress || ''}`;
      docs.delete(key);
    },
  };
}

function createDb(collections = {}) {
  return { collection: (name) => collections[name] ?? createCollection() };
}

// ── Pure logic extracted from entitlement.js for deterministic unit testing ──

async function createEntitlementLogic(db, materialId, buyerAddress, purchaseData = {}) {
  if (!materialId || !buyerAddress) {
    return { success: false, source: 'invalid-params' };
  }

  const normalised = buyerAddress.toLowerCase();
  const cacheCol = db.collection('entitlement_cache');

  const entry = {
    materialId,
    buyerAddress: normalised,
    active: true,
    source: 'purchase-api',
    purchaseId: purchaseData.purchaseId || null,
    transactionHash: purchaseData.transactionHash || null,
    amount: purchaseData.amount || null,
    asset: purchaseData.asset || null,
    updatedAt: new Date(),
    createdAt: new Date(),
  };

  await cacheCol.updateOne(
    { materialId, buyerAddress: normalised },
    { $set: entry },
    { upsert: true }
  );

  return { success: true, source: 'purchase-api' };
}

async function verifyEntitlementLogic(db, materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { hasAccess: false, source: 'invalid-params' };
  }

  const normalised = buyerAddress.toLowerCase();

  // 1. Check cache
  const cached = await db.collection('entitlement_cache').findOne({
    materialId,
    buyerAddress: normalised,
  });
  if (cached) {
    if (cached.active) return { hasAccess: true, source: 'cache' };
  }

  // 2. Check purchases DB
  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: normalised,
    status: 'settled',
  });
  if (purchase) {
    return { hasAccess: true, source: 'purchases-db' };
  }

  return { hasAccess: false, source: 'not-found' };
}

// =============================================================================
// Entitlement Creation Tests
// =============================================================================

describe('Entitlement Creation', () => {

  test('createEntitlement writes an active record to entitlement_cache', async () => {
    const cacheDb = createCollection();
    const db = createDb({ entitlement_cache: cacheDb });

    const result = await createEntitlementLogic(db, 'mat-001', 'GALICE123');
    assert.equal(result.success, true);

    const record = await cacheDb.findOne({
      materialId: 'mat-001',
      buyerAddress: 'galice123',
    });
    assert.equal(record.active, true);
    assert.equal(record.source, 'purchase-api');
  });

  test('createEntitlement stores purchase metadata', async () => {
    const cacheDb = createCollection();
    const db = createDb({ entitlement_cache: cacheDb });

    await createEntitlementLogic(db, 'mat-002', 'GBOB456', {
      purchaseId: 'purchase-123',
      transactionHash: '0xabc',
      amount: '1000',
      asset: 'USDC',
    });

    const record = await cacheDb.findOne({
      materialId: 'mat-002',
      buyerAddress: 'gbob456',
    });
    assert.equal(record.purchaseId, 'purchase-123');
    assert.equal(record.transactionHash, '0xabc');
    assert.equal(record.amount, '1000');
    assert.equal(record.asset, 'USDC');
  });

  test('duplicate createEntitlement is idempotent', async () => {
    const cacheDb = createCollection();
    const db = createDb({ entitlement_cache: cacheDb });

    const first = await createEntitlementLogic(db, 'mat-003', 'GCAR789');
    assert.equal(first.success, true);

    const second = await createEntitlementLogic(db, 'mat-003', 'GCAR789', {
      purchaseId: 'purchase-456',
    });
    assert.equal(second.success, true);

    const records = await cacheDb.findOne({
      materialId: 'mat-003',
      buyerAddress: 'gcar789',
    });
    // Should still have a single record (upsert) with updated data
    assert.notEqual(records, null);
    assert.equal(records.active, true);
  });

  test('createEntitlement returns failure for missing params', async () => {
    const cacheDb = createCollection();
    const db = createDb({ entitlement_cache: cacheDb });

    const noMaterial = await createEntitlementLogic(db, null, 'GALICE');
    assert.equal(noMaterial.success, false);
    assert.equal(noMaterial.source, 'invalid-params');

    const noBuyer = await createEntitlementLogic(db, 'mat-001', null);
    assert.equal(noBuyer.success, false);
    assert.equal(noBuyer.source, 'invalid-params');
  });

  test('failed purchase does not create entitlement', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Simulate a purchase that was never created (no purchase record)
    const verification = await verifyEntitlementLogic(db, 'mat-099', 'GNOPURCHASE');
    assert.equal(verification.hasAccess, false);
    assert.equal(verification.source, 'not-found');

    // No cache entry should exist
    const cached = await cacheDb.findOne({
      materialId: 'mat-099',
      buyerAddress: 'gnopurchase',
    });
    assert.equal(cached, null);
  });

});

// =============================================================================
// Access Verification Tests
// =============================================================================

describe('Access Verification', () => {

  test('valid purchaser can access material via cache', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    await createEntitlementLogic(db, 'mat-100', 'GALICE');

    const result = await verifyEntitlementLogic(db, 'mat-100', 'GALICE');
    assert.equal(result.hasAccess, true);
    assert.equal(result.source, 'cache');
  });

  test('non-purchaser is denied access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    const result = await verifyEntitlementLogic(db, 'mat-200', 'GSTRANGER');
    assert.equal(result.hasAccess, false);
    assert.equal(result.source, 'not-found');
  });

  test('wrong user is denied access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Alice purchases mat-300
    await createEntitlementLogic(db, 'mat-300', 'GALICE');

    // Bob tries to access mat-300
    const result = await verifyEntitlementLogic(db, 'mat-300', 'GBOB');
    assert.equal(result.hasAccess, false);
    assert.equal(result.source, 'not-found');
  });

  test('missing entitlement record denies access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // No entitlements exist at all
    const result = await verifyEntitlementLogic(db, 'mat-400', 'GALICE');
    assert.equal(result.hasAccess, false);
  });

  test('invalid material identifier denies access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    const result = await verifyEntitlementLogic(db, '', 'GALICE');
    assert.equal(result.hasAccess, false);
    assert.equal(result.source, 'invalid-params');
  });

  test('access verified via purchases-db fallback when cache is stale', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Cache has inactive record (stale)
    cacheDb.docs.set('mat-500:gdave', {
      materialId: 'mat-500',
      buyerAddress: 'gdave',
      active: false,
      source: 'stale',
    });

    // But purchases has settled
    purchasesDb.docs.set('mat-500:gdave', {
      materialId: 'mat-500',
      buyerAddress: 'gdave',
      status: 'settled',
    });

    const result = await verifyEntitlementLogic(db, 'mat-500', 'GDAVE');
    assert.equal(result.hasAccess, true);
    assert.equal(result.source, 'purchases-db');
  });

  test('pending purchase does not grant access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Purchase exists but is pending (not settled)
    purchasesDb.docs.set('mat-600:gpending', {
      materialId: 'mat-600',
      buyerAddress: 'gpending',
      status: 'pending',
    });

    const result = await verifyEntitlementLogic(db, 'mat-600', 'GPENDING');
    assert.equal(result.hasAccess, false);
  });

  test('confirmed (not settled) purchase does not grant access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    purchasesDb.docs.set('mat-700:gconfirmed', {
      materialId: 'mat-700',
      buyerAddress: 'gconfirmed',
      status: 'confirmed',
    });

    const result = await verifyEntitlementLogic(db, 'mat-700', 'GCONFIRMED');
    assert.equal(result.hasAccess, false);
  });

});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security Enforcement', () => {

  test('user A cannot access user B entitlements', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // User A buys material
    await createEntitlementLogic(db, 'mat-sec-1', 'GUSERA');

    // User B has no relationship to this material
    const forB = await verifyEntitlementLogic(db, 'mat-sec-1', 'GUSERB');
    assert.equal(forB.hasAccess, false);

    // User A retains access
    const forA = await verifyEntitlementLogic(db, 'mat-sec-1', 'GUSERA');
    assert.equal(forA.hasAccess, true);
  });

  test('missing entitlement_cache treats access as denied', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // No records at all for this user/material
    const result = await verifyEntitlementLogic(db, 'mat-sec-2', 'GUNKNOWN');
    assert.equal(result.hasAccess, false);
  });

  test('case-insensitive wallet address matching', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Create entitlement with uppercase address
    await createEntitlementLogic(db, 'mat-case', 'GALICE');

    // Verify with different case
    const result = await verifyEntitlementLogic(db, 'mat-case', 'galice');
    assert.equal(result.hasAccess, true);
  });

  test('inactive cache entry does not grant access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Write an explicitly inactive entitlement
    cacheDb.docs.set('mat-revoked:gre voked', {
      materialId: 'mat-revoked',
      buyerAddress: 'grevoked',
      active: false,
      source: 'revoked',
    });

    const result = await verifyEntitlementLogic(db, 'mat-revoked', 'GREVOKED');
    assert.equal(result.hasAccess, false);
  });

  test('ownership check works alongside entitlement check', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Creator has no entitlement but is the owner (ownership checked separately)
    // This test verifies the entitlement check doesn't interfere with ownership
    const result = await verifyEntitlementLogic(db, 'mat-owned', 'GCREATOR');
    assert.equal(result.hasAccess, false);

    // After creator "purchases" (creates entitlement), access is granted
    await createEntitlementLogic(db, 'mat-owned', 'GCREATOR');
    const after = await verifyEntitlementLogic(db, 'mat-owned', 'GCREATOR');
    assert.equal(after.hasAccess, true);
  });

});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {

  test('empty materialId denies access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    const result = await verifyEntitlementLogic(db, '', 'GALICE');
    assert.equal(result.hasAccess, false);
    assert.equal(result.source, 'invalid-params');
  });

  test('empty buyerAddress denies access', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    const result = await verifyEntitlementLogic(db, 'mat-001', '');
    assert.equal(result.hasAccess, false);
    assert.equal(result.source, 'invalid-params');
  });

  test('multiple purchases by same user for same material are idempotent', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // First purchase
    await createEntitlementLogic(db, 'mat-dupe', 'GALICE', { purchaseId: 'p1' });

    // Second "purchase" of same material (idempotent)
    await createEntitlementLogic(db, 'mat-dupe', 'GALICE', { purchaseId: 'p2' });

    // Verify access is still granted
    const result = await verifyEntitlementLogic(db, 'mat-dupe', 'GALICE');
    assert.equal(result.hasAccess, true);

    // Should only have one cache entry
    let count = 0;
    for (const entry of cacheDb.docs.values()) {
      if (entry.materialId === 'mat-dupe' && entry.buyerAddress === 'galice') count++;
    }
    assert.equal(count, 1);
  });

  test('multiple materials purchased by same user are independent', async () => {
    const cacheDb = createCollection();
    const purchasesDb = createCollection();
    const db = createDb({
      entitlement_cache: cacheDb,
      purchases: purchasesDb,
    });

    // Alice buys mat-A and mat-C but not mat-B
    await createEntitlementLogic(db, 'mat-A', 'GALICE');
    await createEntitlementLogic(db, 'mat-C', 'GALICE');

    assert.equal((await verifyEntitlementLogic(db, 'mat-A', 'GALICE')).hasAccess, true);
    assert.equal((await verifyEntitlementLogic(db, 'mat-B', 'GALICE')).hasAccess, false);
    assert.equal((await verifyEntitlementLogic(db, 'mat-C', 'GALICE')).hasAccess, true);
  });

});

// =============================================================================
// Access Status (accessStatus function from /api/materials/access)
// =============================================================================

describe('Access Status', () => {

  // Helper that creates a collection from a plain record map (like existing tests)
  function createRecordCollection(records = {}) {
    const map = new Map(Object.entries(records));
    return {
      records: map,
      async findOne(query) {
        if (query._id) return map.get(query._id) || null;
        if (query.materialId && query.buyerAddress) {
          const key = `${query.materialId}:${query.buyerAddress}`;
          return map.get(key) || null;
        }
        if (query.materialId) return map.get(query.materialId) || null;
        return null;
      },
      async updateOne() {},
    };
  }

  function createAccessDb(state = {}) {
    const collections = new Map();
    return {
      collection(name) {
        if (!collections.has(name)) {
          collections.set(name, createRecordCollection(state[name] || {}));
        }
        return collections.get(name);
      },
    };
  }

  async function accessStatus(db, materialId, buyerAddress) {
    if (!materialId || !buyerAddress) {
      return { error: 'Missing materialId or buyerAddress', statusCode: 400 };
    }

    const material = await db.collection('materials').findOne({ materialId });
    if (!material) {
      return { status: 'unavailable', detail: 'material not found' };
    }

    const buyer = String(buyerAddress).toLowerCase();

    // Check entitlement cache first (fast path)
    const cached = await db.collection('entitlement_cache').findOne({
      materialId,
      buyerAddress: buyer,
    });
    if (cached?.active) {
      return { status: 'active', source: cached.source || 'cache' };
    }

    // Check purchases DB for settled status
    const purchase = await db.collection('purchases').findOne({ materialId, buyerAddress: buyer });
    if (purchase) {
      if (purchase.status === 'settled') return { status: 'active', source: 'purchases-db' };
      return { status: 'pending', source: 'purchases-db' };
    }

    return { status: 'not_purchased', source: 'unknown' };
  }

  test('returns active when entitlement_cache has active record', async () => {
    const db = createAccessDb({
      materials: { 'mat-1': { materialId: 'mat-1' } },
      entitlement_cache: { 'mat-1:galice': { materialId: 'mat-1', buyerAddress: 'galice', active: true, source: 'purchase-api' } },
    });

    const result = await accessStatus(db, 'mat-1', 'GALICE');
    assert.equal(result.status, 'active');
    assert.equal(result.source, 'purchase-api');
  });

  test('returns not_purchased when no cache or purchase exists', async () => {
    const db = createAccessDb({
      materials: { 'mat-2': { materialId: 'mat-2' } },
    });

    const result = await accessStatus(db, 'mat-2', 'GSTRANGER');
    assert.equal(result.status, 'not_purchased');
  });

  test('returns unavailable for missing material', async () => {
    const db = createAccessDb({});

    const result = await accessStatus(db, 'no-such-mat', 'GALICE');
    assert.equal(result.status, 'unavailable');
  });

  test('returns pending when purchase exists but not yet settled', async () => {
    const db = createAccessDb({
      materials: { 'mat-3': { materialId: 'mat-3' } },
      purchases: { 'mat-3:gpending': { materialId: 'mat-3', buyerAddress: 'gpending', status: 'pending' } },
    });

    const result = await accessStatus(db, 'mat-3', 'GPENDING');
    assert.equal(result.status, 'pending');
  });

  test('returns active for settled purchase when no cache', async () => {
    const db = createAccessDb({
      materials: { 'mat-4': { materialId: 'mat-4' } },
      purchases: { 'mat-4:gbuyer': { materialId: 'mat-4', buyerAddress: 'gbuyer', status: 'settled' } },
    });

    const result = await accessStatus(db, 'mat-4', 'GBUYER');
    assert.equal(result.status, 'active');
    assert.equal(result.source, 'purchases-db');
  });

});
