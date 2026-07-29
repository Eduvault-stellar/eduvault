import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { createFakeDb } from "./helpers/fakeMongo.mjs";
import {
  getMilestonesByPayout,
  getMilestonesByEscrow,
  getMilestoneById,
  createMilestone,
  updateMilestone,
  transitionMilestoneStatus,
  addMilestoneEvidence,
  getMilestoneEvidence,
  getMilestoneHistory,
} from "../../src/lib/backend/milestoneService.js";

// ── helpers ──────────────────────────────────────────────────────────────────

async function seedMilestones(db, count = 3) {
  const coll = db.collection("milestones");
  for (let i = 0; i < count; i++) {
    await coll.insertOne({
      milestoneId: `m-${i}`,
      payoutId: "payout-1",
      escrowId: "escrow-1",
      order: i,
      title: `Milestone ${i}`,
      status: "pending",
      amount: String((i + 1) * 100),
      evidenceIds: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

// ── READ TESTS ───────────────────────────────────────────────────────────────

describe("milestoneService reads", () => {
  test("getMilestonesByPayout returns all milestones for payout", async () => {
    const db = createFakeDb();
    await seedMilestones(db, 3);

    const results = await getMilestonesByPayout(db, "payout-1");
    assert.equal(results.length, 3);
    assert.equal(results[0].milestoneId, "m-0");
    assert.equal(results[1].milestoneId, "m-1");
    assert.equal(results[2].milestoneId, "m-2");
  });

  test("getMilestonesByPayout returns empty array for unknown payout", async () => {
    const db = createFakeDb();
    await seedMilestones(db);

    const results = await getMilestonesByPayout(db, "payout-unknown");
    assert.deepEqual(results, []);
  });

  test("getMilestonesByPayout falls back to legacy embedded field", async () => {
    const db = createFakeDb();
    const payoutsColl = db.collection("payouts");
    await payoutsColl.insertOne({
      payoutId: "payout-legacy",
      escrowId: "escrow-legacy",
      recipient: "GUSER",
      amount: "1000",
      status: "pending",
      milestones: [
        { milestoneId: "legacy-1", description: "Legacy 1", amount: "500", order: 0 },
        { milestoneId: "legacy-2", description: "Legacy 2", amount: "500", order: 1 },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const results = await getMilestonesByPayout(db, "payout-legacy");
    assert.equal(results.length, 2);
    assert.equal(results[0].milestoneId, "legacy-1");
  });

  test("getMilestonesByEscrow returns milestones", async () => {
    const db = createFakeDb();
    await seedMilestones(db);

    const results = await getMilestonesByEscrow(db, "escrow-1");
    assert.equal(results.length, 3);
  });

  test("getMilestoneById returns single milestone", async () => {
    const db = createFakeDb();
    await seedMilestones(db);

    const result = await getMilestoneById(db, "m-1");
    assert.ok(result);
    assert.equal(result.milestoneId, "m-1");
    assert.equal(result.title, "Milestone 1");
  });

  test("getMilestoneById returns null for unknown", async () => {
    const db = createFakeDb();
    await seedMilestones(db);

    const result = await getMilestoneById(db, "m-999");
    assert.equal(result, null);
  });
});

// ── WRITE TESTS ──────────────────────────────────────────────────────────────

describe("milestoneService writes", () => {
  test("createMilestone inserts a new milestone", async () => {
    const db = createFakeDb();
    db.collection("milestones");
    db.collection("payouts");

    const payoutsColl = db.collection("payouts");
    await payoutsColl.insertOne({
      payoutId: "payout-create",
      escrowId: "escrow-create",
      recipient: "GUSER",
      amount: "1000",
      status: "pending",
      milestones: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await createMilestone(db, {
      payoutId: "payout-create",
      escrowId: "escrow-create",
      order: 0,
      title: "New Milestone",
      amount: "500",
      currency: "USDC",
    });

    assert.ok(result.milestoneId);
    assert.equal(result.title, "New Milestone");
    assert.equal(result.status, "pending");
    assert.equal(result.version, 1);

    const saved = await getMilestoneById(db, result.milestoneId);
    assert.ok(saved);
    assert.equal(saved.payoutId, "payout-create");
  });

  test("updateMilestone updates fields and increments version", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");
    await coll.insertOne({
      milestoneId: "m-update",
      payoutId: "p-1",
      escrowId: "e-1",
      order: 0,
      title: "Original",
      status: "pending",
      amount: "100",
      evidenceIds: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const payoutsColl = db.collection("payouts");
    await payoutsColl.insertOne({
      payoutId: "p-1",
      escrowId: "e-1",
      recipient: "GUSER",
      amount: "1000",
      status: "pending",
      milestones: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const updated = await updateMilestone(db, "m-update", { title: "Updated", status: "submitted" }, 1);
    assert.ok(updated);
    assert.equal(updated.title, "Updated");
    assert.equal(updated.status, "submitted");
    assert.equal(updated.version, 2);
  });

  test("updateMilestone rejects stale version", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");
    await coll.insertOne({
      milestoneId: "m-stale",
      payoutId: "p-1",
      escrowId: "e-1",
      order: 0,
      title: "Original",
      status: "pending",
      amount: "100",
      evidenceIds: [],
      version: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const payoutsColl = db.collection("payouts");
    await payoutsColl.insertOne({
      payoutId: "p-1",
      escrowId: "e-1",
      recipient: "GUSER",
      amount: "1000",
      status: "pending",
      milestones: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await assert.rejects(
      () => updateMilestone(db, "m-stale", { title: "Stale" }, 1),
      (err) => err.message.includes("version conflict"),
    );
  });
});

// ── TRANSITION TESTS ─────────────────────────────────────────────────────────

describe("milestoneService transitions", () => {
  test("transitionMilestoneStatus records history entry", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");
    await coll.insertOne({
      milestoneId: "m-trans",
      payoutId: "p-1",
      escrowId: "e-1",
      order: 0,
      title: "Trans",
      status: "pending",
      amount: "100",
      evidenceIds: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const payoutsColl = db.collection("payouts");
    await payoutsColl.insertOne({
      payoutId: "p-1",
      escrowId: "e-1",
      recipient: "GUSER",
      amount: "1000",
      status: "pending",
      milestones: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await transitionMilestoneStatus(db, "m-trans", "submitted", {
      changedBy: "user-1",
      reason: "Ready for review",
    });

    assert.ok(result.milestone);
    assert.equal(result.milestone.status, "submitted");
    assert.ok(result.history);
    assert.equal(result.history.fromStatus, "pending");
    assert.equal(result.history.toStatus, "submitted");
    assert.equal(result.history.changedBy, "user-1");
    assert.equal(result.history.reason, "Ready for review");

    const history = await getMilestoneHistory(db, "m-trans");
    assert.equal(history.length, 1);
    assert.equal(history[0].toStatus, "submitted");
  });
});

// ── EVIDENCE TESTS ───────────────────────────────────────────────────────────

describe("milestoneService evidence", () => {
  test("addMilestoneEvidence creates evidence record", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");
    await coll.insertOne({
      milestoneId: "m-ev",
      escrowId: "e-1",
      status: "pending",
      evidenceIds: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const evidence = await addMilestoneEvidence(db, "m-ev", {
      uploadedBy: "user-1",
      fileId: "file-1",
      fileUrl: "https://example.com/evidence.pdf",
      fileType: "application/pdf",
      notes: "Screenshot of completion",
    });

    assert.ok(evidence.evidenceId);
    assert.equal(evidence.milestoneId, "m-ev");
    assert.equal(evidence.uploadedBy, "user-1");
    assert.equal(evidence.fileId, "file-1");

    const allEvidence = await getMilestoneEvidence(db, "m-ev");
    assert.equal(allEvidence.length, 1);
    assert.equal(allEvidence[0].evidenceId, evidence.evidenceId);
  });

  test("addMilestoneEvidence updates milestone evidenceIds array", async () => {
    const db = createFakeDb();
    const coll = db.collection("milestones");
    await coll.insertOne({
      milestoneId: "m-ev2",
      escrowId: "e-1",
      status: "pending",
      evidenceIds: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await addMilestoneEvidence(db, "m-ev2", { uploadedBy: "user-1" });

    const milestone = await getMilestoneById(db, "m-ev2");
    assert.ok(milestone);
    assert.equal(milestone.evidenceIds.length, 1);
  });
});
