/**
 * Backend tests for GET /api/creator/analytics — Issue #118
 *
 * Tests the aggregation and access-control logic extracted into
 * pure functions, mirroring the pattern established in entitlement.test.mjs.
 *
 * Run with: npm run test:backend
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

// ─── Minimal in-memory MongoDB doubles ────────────────────────────────────────

function makeCollection(docs = []) {
  const store = [...docs];

  return {
    _store: store,

    async find(query = {}) {
      const results = store.filter((doc) =>
        Object.entries(query).every(([k, v]) => {
          if (v && typeof v === "object" && "$in" in v) {
            return v.$in.includes(doc[k]);
          }
          return doc[k] === v;
        })
      );
      return {
        toArray: async () => results,
        sort: () => ({ limit: () => ({ toArray: async () => results }) }),
      };
    },

    async findOne(query = {}) {
      return (
        store.find((doc) =>
          Object.entries(query).every(([k, v]) => doc[k] === v)
        ) ?? null
      );
    },

    // Simplified aggregate — handles the specific pipelines used by the route
    async aggregate(pipeline) {
      // Step 1: $match
      const matchStage = pipeline.find((s) => s.$match)?.$match ?? {};
      let docs = store.filter((doc) =>
        Object.entries(matchStage).every(([k, v]) => {
          if (v && typeof v === "object") {
            if ("$in" in v) return v.$in.includes(doc[k]);
            if ("$gte" in v && "$lte" in v)
              return doc[k] >= v.$gte && doc[k] <= v.$lte;
            if ("$gte" in v) return doc[k] >= v.$gte;
            if ("$in" in v) return v.$in.includes(doc[k]);
          }
          return doc[k] === v;
        })
      );

      // Step 2: $count
      if (pipeline.some((s) => s.$count)) {
        const field = pipeline.find((s) => s.$count).$count;
        if (docs.length === 0) return { toArray: async () => [] };
        return { toArray: async () => [{ [field]: docs.length }] };
      }

      // Step 3: $group
      const groupStage = pipeline.find((s) => s.$group)?.$group;
      if (groupStage) {
        const groups = new Map();
        for (const doc of docs) {
          const key = groupStage._id === null ? null : doc[groupStage._id?.replace?.("$", "")];
          const existing = groups.get(key) ?? { _id: key };
          for (const [field, expr] of Object.entries(groupStage)) {
            if (field === "_id") continue;
            if (expr.$sum) {
              const val =
                typeof expr.$sum === "number"
                  ? expr.$sum
                  : Number(doc[String(expr.$sum.$toDouble ?? expr.$sum).replace("$", "")]) || 0;
              existing[field] = (existing[field] ?? 0) + val;
            }
            if (expr.$count) {
              existing[field] = (existing[field] ?? 0) + 1;
            }
          }
          groups.set(key, existing);
        }
        const result = [...groups.values()];
        return { toArray: async () => result };
      }

      return { toArray: async () => docs };
    },
  };
}

function makeDb(collections = {}) {
  return {
    collection: (name) => collections[name] ?? makeCollection(),
  };
}

// ─── Extracted analytics logic (mirrors route.js but accepts injected db) ──────

async function getAnalytics(creatorAddress, db, { from, to } = {}) {
  const purchases = db.collection("purchases");
  const materials = db.collection("materials");

  const now = new Date();
  const rangeTo = to ?? now;
  const rangeFrom = from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const creatorMaterials = (await (await materials.find({ userAddress: creatorAddress })).toArray());
  const materialIdStrings = creatorMaterials.map((m) => String(m._id));

  // All-time confirmed
  const allTimeAgg = await (
    await purchases.aggregate([
      { $match: { materialId: { $in: materialIdStrings }, status: "confirmed" } },
      { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } }, count: { $sum: 1 } } },
    ])
  ).toArray();
  const totalRevenue = allTimeAgg[0]?.total ?? 0;
  const totalSales = allTimeAgg[0]?.count ?? 0;

  // Date-windowed confirmed
  const windowAgg = await (
    await purchases.aggregate([
      {
        $match: {
          materialId: { $in: materialIdStrings },
          status: "confirmed",
          purchasedAt: { $gte: rangeFrom, $lte: rangeTo },
        },
      },
      { $count: "count" },
    ])
  ).toArray();
  const monthlySales = windowAgg[0]?.count ?? 0;

  // Pending / indexing
  const pendingAgg = await (
    await purchases.aggregate([
      {
        $match: {
          materialId: { $in: materialIdStrings },
          status: { $in: ["pending", "indexing"] },
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
  ).toArray();
  const pendingCount = pendingAgg.find((g) => g._id === "pending")?.count ?? 0;
  const indexingCount = pendingAgg.find((g) => g._id === "indexing")?.count ?? 0;

  return { totalRevenue, totalSales, monthlySales, pendingCount, indexingCount };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Creator analytics — Issue #118", () => {
  // ── Empty state ─────────────────────────────────────────────────────────────
  test("returns zeros for a creator with no materials", async () => {
    const db = makeDb({
      materials: makeCollection([]),
      purchases: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_EMPTY", db);
    assert.equal(result.totalRevenue, 0);
    assert.equal(result.totalSales, 0);
    assert.equal(result.monthlySales, 0);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.indexingCount, 0);
  });

  // ── Single material, confirmed purchase ─────────────────────────────────────
  test("totalRevenue and totalSales count confirmed purchases", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-1", userAddress: "GCREATOR_1", title: "Intro to Stellar" },
      ]),
      purchases: makeCollection([
        {
          materialId: "mat-1",
          buyerAddress: "GBUYER_A",
          status: "confirmed",
          amount: "10.00",
          purchasedAt: new Date(),
        },
        {
          materialId: "mat-1",
          buyerAddress: "GBUYER_B",
          status: "confirmed",
          amount: "10.00",
          purchasedAt: new Date(),
        },
      ]),
    });

    const result = await getAnalytics("GCREATOR_1", db);
    assert.equal(result.totalSales, 2);
    assert.equal(result.totalRevenue, 20);
  });

  // ── Pending and indexing counts ─────────────────────────────────────────────
  test("pendingCount and indexingCount reflect non-confirmed purchases", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-2", userAddress: "GCREATOR_2", title: "DeFi 101" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-2", buyerAddress: "GBUYER_C", status: "pending", amount: "5", purchasedAt: new Date() },
        { materialId: "mat-2", buyerAddress: "GBUYER_D", status: "indexing", amount: "5", purchasedAt: new Date() },
        { materialId: "mat-2", buyerAddress: "GBUYER_E", status: "confirmed", amount: "5", purchasedAt: new Date() },
      ]),
    });

    const result = await getAnalytics("GCREATOR_2", db);
    assert.equal(result.pendingCount, 1);
    assert.equal(result.indexingCount, 1);
    assert.equal(result.totalSales, 1);
  });

  // ── Multi-material creator ──────────────────────────────────────────────────
  test("aggregates correctly across multiple materials", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-a", userAddress: "GCREATOR_3", title: "Rust Basics" },
        { _id: "mat-b", userAddress: "GCREATOR_3", title: "Wasm Deep Dive" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-a", buyerAddress: "GBUYER_1", status: "confirmed", amount: "20", purchasedAt: new Date() },
        { materialId: "mat-b", buyerAddress: "GBUYER_2", status: "confirmed", amount: "30", purchasedAt: new Date() },
        { materialId: "mat-b", buyerAddress: "GBUYER_3", status: "confirmed", amount: "30", purchasedAt: new Date() },
      ]),
    });

    const result = await getAnalytics("GCREATOR_3", db);
    assert.equal(result.totalSales, 3);
    assert.equal(result.totalRevenue, 80);
  });

  // ── Cross-creator isolation ─────────────────────────────────────────────────
  test("does not include purchases for another creator's materials", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-own", userAddress: "GCREATOR_A", title: "My Material" },
        { _id: "mat-other", userAddress: "GCREATOR_B", title: "Other Material" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-own", buyerAddress: "GBUYER_X", status: "confirmed", amount: "15", purchasedAt: new Date() },
        { materialId: "mat-other", buyerAddress: "GBUYER_Y", status: "confirmed", amount: "99", purchasedAt: new Date() },
      ]),
    });

    const result = await getAnalytics("GCREATOR_A", db);
    assert.equal(result.totalSales, 1);
    assert.equal(result.totalRevenue, 15);
  });

  // ── Date range filter ───────────────────────────────────────────────────────
  test("date range filter narrows monthlySales correctly", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);   // 5 days ago
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);     // 60 days ago

    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-dr", userAddress: "GCREATOR_DR", title: "NFT Guide" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-dr", buyerAddress: "GBUYER_R", status: "confirmed", amount: "10", purchasedAt: recent },
        { materialId: "mat-dr", buyerAddress: "GBUYER_O", status: "confirmed", amount: "10", purchasedAt: old },
      ]),
    });

    const windowStart = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const result = await getAnalytics("GCREATOR_DR", db, { from: windowStart, to: now });

    // Only the "recent" purchase falls within the 10-day window
    assert.equal(result.monthlySales, 1);
    // But totalSales is all-time
    assert.equal(result.totalSales, 2);
  });
});
