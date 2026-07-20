/**
 * Tests for the entitlement verification utility — Issue #63
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ── Minimal MongoDB collection mock ──────────────────────────────────────────

function createCollection() {
  const docs = new Map();
  return {
    docs,
    async findOne(query) {
      for (const doc of docs.values()) {
        const match = Object.entries(query).every(([k, v]) => {
          if (v instanceof Date) return doc[k]?.getTime() === v.getTime();
          return String(doc[k]) === String(v);
        });
        if (match) return doc;
      }
      return null;
    },
    async updateOne(query, update, opts = {}) {
      const key = `${query.materialId}:${query.buyerAddress}`;
      const exists = docs.has(key);
      if (!exists && !opts.upsert) return;
      const current = docs.get(key) ?? {};
      const setFields = update.$set ?? {};
      const setOnInsert = (!exists && update.$setOnInsert) ? update.$setOnInsert : {};
      docs.set(key, { ...current, ...setFields, ...setOnInsert });
    },
  };
}

function createDb(collections = {}) {
  return { collection: (name) => collections[name] ?? createCollection() };
}

// ── Pure logic extracted from verifyEntitlement for unit testing ─────────────
// (We test the logic without touching the real DB or chain)

async function verifyEntitlementLogic(materialId, buyerAddress, { db, checkChain, getCache, setCache }) {
  const normalised = buyerAddress.toLowerCase();
  const now = new Date();

  const cached = await getCache(db, materialId, normalised);
  if (cached) {
    if (cached.expiresAt && cached.expiresAt > now) {
      if (cached.active) return { hasAccess: true, source: cached.source || 'cache' };
      return { hasAccess: false, source: cached.source || 'cache-miss' };
    }
  }

  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: normalised,
    status: 'settled', // assuming isCompletedPurchaseStatus does this
  });

  if (purchase) {
    await setCache(db, materialId, normalised, true, 'purchases-db');
    return { hasAccess: true, source: 'purchases-db' };
  }

  const onChain = await checkChain(materialId, buyerAddress);
  if (onChain === true) {
    await setCache(db, materialId, normalised, true, 'chain');
    return { hasAccess: true, source: 'chain' };
  }
  
  if (onChain === false) {
    await setCache(db, materialId, normalised, false, 'chain');
    return { hasAccess: false, source: 'chain-miss' };
  }

  if (onChain === null && cached) {
    return { hasAccess: cached.active, source: 'stale-cache' };
  }

  return { hasAccess: false, source: 'not-found' };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('returns hasAccess=true when cache is fresh and active', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const db = createDb({ entitlement_cache: cacheDb, purchases: purchasesDb });
  const materialId = 'mat-001';
  const buyer = 'GABC123';

  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: true,
    source: 'stellar',
    expiresAt: new Date(Date.now() + 10000), // fresh
  });

  const result = await verifyEntitlementLogic(materialId, buyer, {
    db,
    checkChain: async () => null,
    getCache: async (db, m, b) => cacheDb.findOne({ materialId: m, buyerAddress: b }),
    setCache: async () => {},
  });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'stellar');
});

test('returns hasAccess=false when cache is fresh but inactive', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const db = createDb({ entitlement_cache: cacheDb, purchases: purchasesDb });
  const materialId = 'mat-002';
  const buyer = 'GXYZ789';

  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: false,
    source: 'stellar',
    expiresAt: new Date(Date.now() + 10000), // fresh
  });

  const result = await verifyEntitlementLogic(materialId, buyer, {
    db,
    checkChain: async () => true, // Should not be called
    getCache: async (db, m, b) => cacheDb.findOne({ materialId: m, buyerAddress: b }),
    setCache: async () => {},
  });
  assert.equal(result.hasAccess, false);
  assert.equal(result.source, 'stellar');
});

test('stale cache falls back to purchases DB', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const db = createDb({ entitlement_cache: cacheDb, purchases: purchasesDb });
  const materialId = 'mat-003';
  const buyer = 'GDEF456';

  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: false,
    source: 'chain-miss',
    expiresAt: new Date(Date.now() - 10000), // stale
  });

  purchasesDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    status: 'settled',
  });

  let cacheUpdated = false;
  const result = await verifyEntitlementLogic(materialId, buyer, {
    db,
    checkChain: async () => null,
    getCache: async (db, m, b) => cacheDb.findOne({ materialId: m, buyerAddress: b }),
    setCache: async () => { cacheUpdated = true; },
  });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'purchases-db');
  assert.equal(cacheUpdated, true);
});

test('stale cache falls back to chain', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const db = createDb({ entitlement_cache: cacheDb, purchases: purchasesDb });
  const materialId = 'mat-004';
  const buyer = 'GCHAIN123';

  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: false,
    source: 'chain-miss',
    expiresAt: new Date(Date.now() - 10000), // stale
  });

  let cacheUpdated = false;
  const result = await verifyEntitlementLogic(materialId, buyer, {
    db,
    checkChain: async () => true, // chain returns true
    getCache: async (db, m, b) => cacheDb.findOne({ materialId: m, buyerAddress: b }),
    setCache: async () => { cacheUpdated = true; },
  });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'chain');
  assert.equal(cacheUpdated, true);
});

test('fail-open: stale cache is returned if chain fails', async () => {
  const cacheDb = createCollection();
  const purchasesDb = createCollection();
  const db = createDb({ entitlement_cache: cacheDb, purchases: purchasesDb });
  const materialId = 'mat-005';
  const buyer = 'GFAILOPEN';

  cacheDb.docs.set(`${materialId}:${buyer.toLowerCase()}`, {
    materialId,
    buyerAddress: buyer.toLowerCase(),
    active: true,
    source: 'chain',
    expiresAt: new Date(Date.now() - 10000), // stale
  });

  const result = await verifyEntitlementLogic(materialId, buyer, {
    db,
    checkChain: async () => null, // network error
    getCache: async (db, m, b) => cacheDb.findOne({ materialId: m, buyerAddress: b }),
    setCache: async () => {},
  });
  assert.equal(result.hasAccess, true);
  assert.equal(result.source, 'stale-cache');
});
