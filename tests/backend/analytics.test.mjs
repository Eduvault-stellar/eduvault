/**
 * Backend tests for GET /api/creator/analytics - Issues #118 and #193.
 *
 * Tests the aggregation and educator dashboard logic using in-memory doubles,
 * mirroring the API route while keeping the tests fast and deterministic.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object") {
      if ("$in" in value) return value.$in.includes(doc[key]);
      if ("$gte" in value && "$lte" in value) {
        return doc[key] >= value.$gte && doc[key] <= value.$lte;
      }
      if ("$gte" in value) return doc[key] >= value.$gte;
    }
    return doc[key] === value;
  });
}

function makeCursor(results) {
  return {
    toArray: async () => results,
    sort: () => makeCursor(results),
    limit: (count) => makeCursor(results.slice(0, count)),
  };
}

function makeCollection(docs = []) {
  const store = [...docs];

  return {
    _store: store,

    async find(query = {}) {
      return makeCursor(store.filter((doc) => matchesQuery(doc, query)));
    },

    async findOne(query = {}) {
      return store.find((doc) => matchesQuery(doc, query)) ?? null;
    },

    async aggregate(pipeline) {
      const matchStage = pipeline.find((stage) => stage.$match)?.$match ?? {};
      const matched = store.filter((doc) => matchesQuery(doc, matchStage));

      if (pipeline.some((stage) => stage.$count)) {
        const field = pipeline.find((stage) => stage.$count).$count;
        return makeCursor(matched.length === 0 ? [] : [{ [field]: matched.length }]);
      }

      const groupStage = pipeline.find((stage) => stage.$group)?.$group;
      if (!groupStage) return makeCursor(matched);

      const groups = new Map();
      for (const doc of matched) {
        const key = groupStage._id === null ? null : doc[groupStage._id?.replace?.("$", "")];
        const existing = groups.get(key) ?? { _id: key };

        for (const [field, expression] of Object.entries(groupStage)) {
          if (field === "_id") continue;
          if (expression.$sum) {
            const value =
              typeof expression.$sum === "number"
                ? expression.$sum
                : Number(doc[String(expression.$sum.$toDouble ?? expression.$sum).replace("$", "")]) || 0;
            existing[field] = (existing[field] ?? 0) + value;
          }
        }

        groups.set(key, existing);
      }

      return makeCursor([...groups.values()]);
    },
  };
}

function makeDb(collections = {}) {
  return {
    collection: (name) => collections[name] ?? makeCollection(),
  };
}

function getMaterialActivity(material) {
  return (
    Number(material.views ?? material.viewCount ?? 0) +
    Number(material.downloads ?? material.downloadCount ?? 0) +
    Number(material.reviewsCount ?? material.reviewCount ?? 0)
  );
}

async function getAnalytics(creatorAddress, db, { from, to } = {}) {
  const purchases = db.collection("purchases");
  const materials = db.collection("materials");
  const savedMaterials = db.collection("saved_materials");
  const completedStatuses = ["confirmed", "settled", "completed"];

  const now = new Date();
  const rangeTo = to ?? now;
  const rangeFrom = from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const creatorMaterials = await (await materials.find({ userAddress: creatorAddress })).toArray();
  const materialIdStrings = creatorMaterials.map((material) => String(material._id));
  const uploadCount = creatorMaterials.length;
  const publishedCount = creatorMaterials.filter((material) => material.visibility !== "private").length;
  const draftCount = uploadCount - publishedCount;
  const materialActivity = creatorMaterials.reduce(
    (total, material) => total + getMaterialActivity(material),
    0
  );
  const savedDocs = await (
    await savedMaterials.find({ materialId: { $in: materialIdStrings } })
  ).toArray();
  const savedCount = savedDocs.length;

  const allTimeAgg = await (
    await purchases.aggregate([
      {
        $match: {
          materialId: { $in: materialIdStrings },
          status: { $in: completedStatuses },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: "$amount" } },
          count: { $sum: 1 },
        },
      },
    ])
  ).toArray();
  const totalRevenue = allTimeAgg[0]?.total ?? 0;
  const totalSales = allTimeAgg[0]?.count ?? 0;

  const windowAgg = await (
    await purchases.aggregate([
      {
        $match: {
          materialId: { $in: materialIdStrings },
          status: { $in: completedStatuses },
          purchasedAt: { $gte: rangeFrom, $lte: rangeTo },
        },
      },
      { $count: "count" },
    ])
  ).toArray();
  const monthlySales = windowAgg[0]?.count ?? 0;

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
  const pendingCount = pendingAgg.find((group) => group._id === "pending")?.count ?? 0;
  const indexingCount = pendingAgg.find((group) => group._id === "indexing")?.count ?? 0;
  const learnerInterest = savedCount + pendingCount + indexingCount;

  return {
    totalRevenue,
    totalSales,
    monthlySales,
    pendingCount,
    indexingCount,
    uploadCount,
    publishedCount,
    draftCount,
    materialActivity,
    savedCount,
    learnerInterest,
    completedOrders: totalSales,
  };
}

describe("Creator analytics - Issues #118 and #193", () => {
  test("returns zeros for a creator with no materials", async () => {
    const db = makeDb({
      materials: makeCollection([]),
      purchases: makeCollection([]),
      saved_materials: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_EMPTY", db);
    assert.equal(result.totalRevenue, 0);
    assert.equal(result.totalSales, 0);
    assert.equal(result.monthlySales, 0);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.indexingCount, 0);
    assert.equal(result.uploadCount, 0);
    assert.equal(result.learnerInterest, 0);
    assert.equal(result.completedOrders, 0);
  });

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
      saved_materials: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_1", db);
    assert.equal(result.totalSales, 2);
    assert.equal(result.completedOrders, 2);
    assert.equal(result.totalRevenue, 20);
  });

  test("settled purchases count as completed orders", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-settled", userAddress: "GCREATOR_SETTLED", title: "Settled Access" },
      ]),
      purchases: makeCollection([
        {
          materialId: "mat-settled",
          buyerAddress: "GBUYER_SETTLED",
          status: "settled",
          amount: "7",
          purchasedAt: new Date(),
        },
      ]),
      saved_materials: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_SETTLED", db);
    assert.equal(result.completedOrders, 1);
    assert.equal(result.totalRevenue, 7);
  });

  test("pendingCount and indexingCount reflect incomplete purchases", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-2", userAddress: "GCREATOR_2", title: "DeFi 101" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-2", buyerAddress: "GBUYER_C", status: "pending", amount: "5", purchasedAt: new Date() },
        { materialId: "mat-2", buyerAddress: "GBUYER_D", status: "indexing", amount: "5", purchasedAt: new Date() },
        { materialId: "mat-2", buyerAddress: "GBUYER_E", status: "confirmed", amount: "5", purchasedAt: new Date() },
      ]),
      saved_materials: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_2", db);
    assert.equal(result.pendingCount, 1);
    assert.equal(result.indexingCount, 1);
    assert.equal(result.learnerInterest, 2);
    assert.equal(result.totalSales, 1);
  });

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
      saved_materials: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_3", db);
    assert.equal(result.totalSales, 3);
    assert.equal(result.totalRevenue, 80);
  });

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
      saved_materials: makeCollection([]),
    });

    const result = await getAnalytics("GCREATOR_A", db);
    assert.equal(result.totalSales, 1);
    assert.equal(result.totalRevenue, 15);
  });

  test("date range filter narrows monthlySales correctly", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-dr", userAddress: "GCREATOR_DR", title: "NFT Guide" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-dr", buyerAddress: "GBUYER_R", status: "confirmed", amount: "10", purchasedAt: recent },
        { materialId: "mat-dr", buyerAddress: "GBUYER_O", status: "confirmed", amount: "10", purchasedAt: old },
      ]),
      saved_materials: makeCollection([]),
    });

    const windowStart = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const result = await getAnalytics("GCREATOR_DR", db, { from: windowStart, to: now });

    assert.equal(result.monthlySales, 1);
    assert.equal(result.totalSales, 2);
  });

  test("returns educator uploads, material activity, and saved-material interest", async () => {
    const db = makeDb({
      materials: makeCollection([
        {
          _id: "mat-uploaded",
          userAddress: "GCREATOR_EDU",
          title: "Educator Dashboard Notes",
          visibility: "public",
          views: 4,
          downloads: 2,
          reviewsCount: 1,
        },
        {
          _id: "mat-private",
          userAddress: "GCREATOR_EDU",
          title: "Draft Pack",
          visibility: "private",
        },
      ]),
      purchases: makeCollection([
        { materialId: "mat-uploaded", buyerAddress: "GBUYER_1", status: "settled", amount: "12", purchasedAt: new Date() },
        { materialId: "mat-uploaded", buyerAddress: "GBUYER_2", status: "pending", amount: "12", purchasedAt: new Date() },
      ]),
      saved_materials: makeCollection([
        { materialId: "mat-uploaded", walletAddress: "gbuyer_3", savedAt: new Date() },
        { materialId: "mat-private", walletAddress: "gbuyer_4", savedAt: new Date() },
      ]),
    });

    const result = await getAnalytics("GCREATOR_EDU", db);

    assert.equal(result.uploadCount, 2);
    assert.equal(result.publishedCount, 1);
    assert.equal(result.draftCount, 1);
    assert.equal(result.materialActivity, 7);
    assert.equal(result.savedCount, 2);
    assert.equal(result.learnerInterest, 3);
    assert.equal(result.completedOrders, 1);
    assert.equal(result.totalRevenue, 12);
  });
});
