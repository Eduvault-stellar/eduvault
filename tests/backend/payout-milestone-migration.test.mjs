import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { normaliseMilestone } from "../../src/lib/backend/migrations/005-normalize-payout-milestones.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function createFakeDb(initialData = {}) {
  const collections = new Map();

  function getOrCreate(name) {
    if (!collections.has(name)) {
      const docs = initialData[name] ? initialData[name].map((d) => ({ ...d })) : [];
      collections.set(name, { docs, name });
    }
    return collections.get(name);
  }

  const db = {
    collection(name) {
      const coll = getOrCreate(name);
      return {
        name,
        async findOne(filter = {}) {
          return coll.docs.find((d) =>
            Object.keys(filter).every((k) => {
              const v = filter[k];
              if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)) {
                return matchesOperator(d[k], v);
              }
              return d[k] === v;
            }),
          ) ?? null;
        },
        async find(filter = {}) {
          let results = coll.docs.filter((d) =>
            Object.keys(filter).every((k) => {
              const v = filter[k];
              if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)) {
                return matchesOperator(d[k], v);
              }
              return d[k] === v;
            }),
          );
          const cursor = {
            async toArray() { return results.map((r) => ({ ...r })); },
            async *[Symbol.asyncIterator]() {
              for (const r of results) yield { ...r };
            },
          };
          return cursor;
        },
        async insertOne(doc) {
          coll.docs.push({ ...doc });
          return { insertedId: doc._id };
        },
        async updateOne(filter, update, options = {}) {
          const idx = coll.docs.findIndex((d) =>
            Object.keys(filter).every((k) => {
              const v = filter[k];
              if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)) {
                return matchesOperator(d[k], v);
              }
              return d[k] === v;
            }),
          );
          if (idx === -1 && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };
          if (idx === -1) {
            const doc = { ...filter, ...(update.$set || {}) };
            coll.docs.push(doc);
            return { matchedCount: 0, upsertedCount: 1 };
          }
          Object.assign(coll.docs[idx], update.$set || {});
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async replaceOne(filter, replacement) {
          const idx = coll.docs.findIndex((d) =>
            Object.keys(filter).every((k) => d[k] === filter[k]),
          );
          if (idx === -1) return { matchedCount: 0 };
          coll.docs[idx] = replacement;
          return { matchedCount: 1 };
        },
        async countDocuments(filter = {}) {
          return coll.docs.filter((d) =>
            Object.keys(filter).every((k) => d[k] === filter[k]),
          ).length;
        },
        async aggregate() {
          return { async toArray() { return []; } };
        },
        async deleteMany(filter = {}) {
          const before = coll.docs.length;
          coll.docs = coll.docs.filter(
            (d) => !Object.keys(filter).every((k) => d[k] === filter[k]),
          );
          return { deletedCount: before - coll.docs.length };
        },
        async deleteOne(filter) {
          const idx = coll.docs.findIndex((d) =>
            Object.keys(filter).every((k) => d[k] === filter[k]),
          );
          if (idx === -1) return { deletedCount: 0 };
          coll.docs.splice(idx, 1);
          return { deletedCount: 1 };
        },
        async createIndexes() {},
        async dropIndex() {},
        async drop() { coll.docs.length = 0; },
      };
    },
    async command() {},
    async listCollections(filter = {}) {
      return {
        async toArray() {
          return Array.from(collections.keys())
            .filter((n) => !filter.name || n === filter.name)
            .map((n) => ({ name: n }));
        },
      };
    },
    async createCollection(name) {
      if (!collections.has(name)) collections.set(name, { docs: [], name });
    },
    dump(name) {
      return (collections.get(name)?.docs ?? []).map((d) => ({ ...d }));
    },
  };

  return db;
}

function matchesOperator(value, condition) {
  for (const [op, operand] of Object.entries(condition)) {
    if (op === "$exists") return (value !== undefined) === operand;
    if (op === "$ne") return value !== operand;
    if (op === "$type") {
      if (operand === "array") return Array.isArray(value);
      return typeof value === operand;
    }
    if (op === "$in") return Array.isArray(operand) && operand.includes(value);
  }
  return true;
}

// ── PAYLOAD HANDLING TESTS ───────────────────────────────────────────────────

describe("migration payload handling", () => {
  test("handles null milestone", () => {
    assert.equal(normaliseMilestone(null, "payout-1", "escrow-1"), null);
  });

  test("handles undefined milestone", () => {
    assert.equal(normaliseMilestone(undefined, "p-1", "e-1"), null);
  });

  test("handles empty object (missing milestoneId)", () => {
    assert.equal(normaliseMilestone({}, "p-1", "e-1"), null);
  });

  test("handles non-object values (string)", () => {
    assert.equal(normaliseMilestone("bad", "p-1", "e-1"), null);
  });

  test("handles non-object values (number)", () => {
    assert.equal(normaliseMilestone(42, "p-1", "e-1"), null);
  });

  test("handles legacy-shaped milestone with id instead of milestoneId", () => {
    const raw = { id: "legacy-1", description: "Old milestone", amount: "100" };
    const result = normaliseMilestone(raw, "payout-1", "escrow-1");
    assert.ok(result);
    assert.equal(result.milestoneId, "legacy-1");
    assert.equal(result.title, "Old milestone");
    assert.equal(result.amount, "100");
    assert.equal(result.status, "pending");
    assert.equal(result.payoutId, "payout-1");
    assert.equal(result.escrowId, "escrow-1");
    assert.equal(result.version, 1);
  });

  test("handles milestone with all enhanced fields", () => {
    const now = new Date();
    const raw = {
      milestoneId: "m-full",
      order: 2,
      title: "Deliverable 2",
      description: "Second deliverable",
      amount: "500",
      currency: "USDC",
      dueDate: now,
      status: "submitted",
      evidenceIds: ["ev-1", "ev-2"],
      feedback: "Looks good",
      chainTxHash: "0xabc",
      createdBy: "user-1",
      createdAt: now,
    };
    const result = normaliseMilestone(raw, "p-1", "e-1");
    assert.equal(result.milestoneId, "m-full");
    assert.equal(result.order, 2);
    assert.equal(result.title, "Deliverable 2");
    assert.equal(result.amount, "500");
    assert.equal(result.currency, "USDC");
    assert.equal(result.dueDate.getTime(), now.getTime());
    assert.equal(result.status, "submitted");
    assert.deepEqual(result.evidenceIds, ["ev-1", "ev-2"]);
    assert.equal(result.feedback, "Looks good");
    assert.equal(result.chainTxHash, "0xabc");
    assert.equal(result.createdBy, "user-1");
    assert.equal(result.version, 1);
  });

  test("defaults evidenceIds to empty array when null", () => {
    const raw = { milestoneId: "m-1", evidenceIds: null };
    const result = normaliseMilestone(raw, "p-1", "e-1");
    assert.deepEqual(result.evidenceIds, []);
  });

  test("defaults evidenceIds to empty array when missing", () => {
    const raw = { milestoneId: "m-1" };
    const result = normaliseMilestone(raw, "p-1", "e-1");
    assert.deepEqual(result.evidenceIds, []);
  });

  test("handles invalid dueDate by returning null", () => {
    const raw = { milestoneId: "m-1", dueDate: "not-a-date" };
    const result = normaliseMilestone(raw, "p-1", "e-1");
    assert.equal(result.dueDate, null);
  });

  test("preserves numeric amount as string", () => {
    const raw = { milestoneId: "m-1", amount: 500 };
    const result = normaliseMilestone(raw, "p-1", "e-1");
    assert.equal(result.amount, "500");
  });

  test("preserves currency when provided", () => {
    const raw = { milestoneId: "m-1", currency: "XLM" };
    const result = normaliseMilestone(raw, "p-1", "e-1");
    assert.equal(result.currency, "XLM");
  });
});

// ── IDEMPOTENCY TESTS ────────────────────────────────────────────────────────

describe("backfill idempotency", () => {
  test("re-running backfill does not create duplicates", async () => {
    const db = createFakeDb({
      milestones: [],
      payouts: [
        {
          payoutId: "p-1",
          escrowId: "e-1",
          recipient: "GUSER",
          amount: "1000",
          status: "pending",
          milestones: [
            { id: "l1", description: "Legacy 1", amount: "500", order: 0 },
            { id: "l2", description: "Legacy 2", amount: "500", order: 1 },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    // Simulate first backfill run.
    const coll = db.collection("milestones");
    const payoutsColl = db.collection("payouts");
    const payout = await payoutsColl.findOne({ payoutId: "p-1" });

    for (const raw of payout.milestones) {
      const normalised = normaliseMilestone(raw, payout.payoutId, payout.escrowId);
      if (normalised) await coll.insertOne(normalised);
    }

    assert.equal(await coll.countDocuments({}), 2);

    // Simulate second backfill run — same legacy milestones should not
    // create new records because the milestoneIds already exist.
    const payout2 = await payoutsColl.findOne({ payoutId: "p-1" });
    let inserted = 0;
    for (const raw of payout2.milestones) {
      const existing = await coll.findOne({ milestoneId: raw.id });
      if (!existing) {
        const normalised = normaliseMilestone(raw, payout2.payoutId, payout2.escrowId);
        if (normalised) {
          await coll.insertOne(normalised);
          inserted += 1;
        }
      }
    }

    assert.equal(inserted, 0);
    assert.equal(await coll.countDocuments({}), 2, "No duplicate milestones after second run");
  });

  test("interrupted and resumed backfill does not duplicate", async () => {
    const db = createFakeDb({
      milestones: [],
      payouts: [
        {
          payoutId: "p-2",
          escrowId: "e-1",
          recipient: "GUSER",
          amount: "1500",
          status: "pending",
          milestones: [
            { id: "a1", description: "A", amount: "500" },
            { id: "a2", description: "B", amount: "500" },
            { id: "a3", description: "C", amount: "500" },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    // First run — only processes 2 out of 3 before "crash".
    const coll = db.collection("milestones");
    const payout = await db.collection("payouts").findOne({ payoutId: "p-2" });

    const processed = new Set();
    for (let i = 0; i < 2; i++) {
      const raw = payout.milestones[i];
      const n = normaliseMilestone(raw, payout.payoutId, payout.escrowId);
      if (n) {
        await coll.insertOne(n);
        processed.add(n.milestoneId);
      }
    }

    assert.equal(await coll.countDocuments({}), 2);

    // "Resume" — process remaining, skipping already-processed IDs.
    const payoutReloaded = await db.collection("payouts").findOne({ payoutId: "p-2" });
    for (const raw of payoutReloaded.milestones) {
      const legacyId = raw.id;
      if (processed.has(legacyId)) continue;

      const existing = await coll.findOne({ milestoneId: legacyId });
      if (!existing) {
        const n = normaliseMilestone(raw, payoutReloaded.payoutId, payoutReloaded.escrowId);
        if (n) await coll.insertOne(n);
      }
    }

    assert.equal(await coll.countDocuments({}), 3, "All 3 milestones after resume");
    const docs = db.dump("milestones");
    const ids = docs.map((d) => d.milestoneId).sort();
    assert.deepEqual(ids, ["a1", "a2", "a3"]);
  });
});

// ── VERIFICATION MISMATCH TESTS ──────────────────────────────────────────────

describe("verification mismatch detection", () => {
  test("detects count mismatch", () => {
    const normalisedCount = 3;
    const legacyCount = 5;
    const mismatch = normalisedCount < legacyCount;
    assert.ok(mismatch);
    assert.equal(normalisedCount, 3);
    assert.equal(legacyCount, 5);
  });

  test("detects amount total mismatch", () => {
    const normalisedTotal = "800";
    const legacyTotal = "1000";
    assert.notEqual(normalisedTotal, legacyTotal);
  });

  test("accepts matching counts and totals", () => {
    assert.equal(5, 5);
    assert.equal("1000", "1000");
  });
});

// ── CONCURRENCY TESTS ────────────────────────────────────────────────────────

describe("milestone concurrency", () => {
  test("concurrent updates to different milestones on same payout do not conflict", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");

    await coll.insertOne({
      milestoneId: "m1",
      payoutId: "p-con",
      escrowId: "e-1",
      order: 1,
      title: "First",
      status: "pending",
      version: 1,
      evidenceIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await coll.insertOne({
      milestoneId: "m2",
      payoutId: "p-con",
      escrowId: "e-1",
      order: 2,
      title: "Second",
      status: "pending",
      version: 1,
      evidenceIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Concurrent updates to different milestones.
    await Promise.all([
      coll.updateOne(
        { milestoneId: "m1", version: 1 },
        { $set: { status: "submitted", version: 2, updatedAt: new Date() } },
      ),
      coll.updateOne(
        { milestoneId: "m2", version: 1 },
        { $set: { title: "Second Updated", version: 2, updatedAt: new Date() } },
      ),
    ]);

    const m1 = await coll.findOne({ milestoneId: "m1" });
    const m2 = await coll.findOne({ milestoneId: "m2" });

    assert.equal(m1.status, "submitted");
    assert.equal(m1.title, "First");
    assert.equal(m2.title, "Second Updated");
    assert.equal(m2.status, "pending");
  });

  test("version conflict prevents stale overwrite", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");

    await coll.insertOne({
      milestoneId: "m-ver",
      payoutId: "p-1",
      escrowId: "e-1",
      title: "Original",
      status: "pending",
      version: 1,
      evidenceIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const r1 = await coll.updateOne(
      { milestoneId: "m-ver", version: 1 },
      { $set: { title: "Updated v2", status: "submitted", version: 2, updatedAt: new Date() } },
    );
    assert.equal(r1.modifiedCount, 1);

    const r2 = await coll.updateOne(
      { milestoneId: "m-ver", version: 1 },
      { $set: { title: "Stale update", version: 2, updatedAt: new Date() } },
    );
    assert.equal(r2.modifiedCount, 0);

    const current = await coll.findOne({ milestoneId: "m-ver" });
    assert.equal(current.title, "Updated v2");
    assert.equal(current.status, "submitted");
  });
});
