import process from "node:process";

import {
  COLLECTION_VALIDATORS,
  COLLECTIONS,
  REQUIRED_INDEXES,
} from "../schemaContracts.js";

const MILESTONE_COLLECTION = COLLECTIONS.milestones;
const EVIDENCE_COLLECTION = COLLECTIONS.milestoneEvidence || "milestone_evidence";
const HISTORY_COLLECTION = COLLECTIONS.milestoneHistory || "milestone_history";
const PAYOUT_COLLECTION = COLLECTIONS.payouts;

const BACKFILL_BATCH_SIZE = Number.parseInt(
  process.env.MIGRATION_BACKFILL_BATCH_SIZE || "100",
  10,
);

// ── helpers ──────────────────────────────────────────────────────────────────

async function collectionExists(db, name) {
  const collections = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return collections.length > 0;
}

async function ensureCollection(db, name) {
  if (!(await collectionExists(db, name))) {
    await db.createCollection(name);
  }
}

function normaliseMilestone(raw, payoutId, escrowId) {
  if (!raw || typeof raw !== "object") return null;

  const milestoneId = raw.milestoneId || raw.id || null;
  if (!milestoneId) return null;

  const amount = raw.amount != null ? String(raw.amount) : null;

  let dueDate = null;
  if (raw.dueDate) {
    dueDate = raw.dueDate instanceof Date ? raw.dueDate : new Date(raw.dueDate);
    if (Number.isNaN(dueDate.getTime())) dueDate = null;
  }

  let createdAt = raw.createdAt instanceof Date ? raw.createdAt : raw.createdAt ? new Date(raw.createdAt) : null;
  if (createdAt && Number.isNaN(createdAt.getTime())) createdAt = null;

  return {
    milestoneId,
    payoutId: payoutId || null,
    escrowId: escrowId || raw.escrowId || "",
    order: raw.order != null ? raw.order : 0,
    title: raw.title || raw.description || "",
    description: raw.description || null,
    amount,
    currency: raw.currency || null,
    dueDate,
    status: raw.status || "pending",
    evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds : [],
    feedback: raw.feedback || null,
    chainTxHash: raw.chainTxHash || null,
    createdBy: raw.createdBy || null,
    version: 1,
    createdAt: createdAt || new Date(0),
    updatedAt: new Date(),
  };
}

// ── stages ───────────────────────────────────────────────────────────────────

/**
 * Stage 1 — Expand: create new collections and indexes alongside existing
 * data without touching anything.
 */
async function stageExpand({ db, logger }) {
  const newCollections = [EVIDENCE_COLLECTION, HISTORY_COLLECTION];

  for (const name of newCollections) {
    await ensureCollection(db, name);
    logger.info?.("[migration:005] Collection ensured", { collectionName: name });
  }

  // Ensure the milestones collection itself exists (it should from migration 001,
  // but be safe).
  if (!(await collectionExists(db, MILESTONE_COLLECTION))) {
    await db.createCollection(MILESTONE_COLLECTION);
    logger.info?.("[migration:005] Milestones collection created");
  }

  // Apply validators (moderate level to allow legacy docs through).
  const validatorCollections = [MILESTONE_COLLECTION, EVIDENCE_COLLECTION, HISTORY_COLLECTION];
  for (const name of validatorCollections) {
    const validator = COLLECTION_VALIDATORS[name];
    if (validator) {
      try {
        await db.command({
          collMod: name,
          validator,
          validationLevel: "moderate",
          validationAction: "error",
        });
        logger.info?.("[migration:005] Validator applied", { collectionName: name });
      } catch (err) {
        // Collection might not exist in COLLECTION_VALIDATORS yet.
        logger.warn?.("[migration:005] Validator skipped", { collectionName: name, reason: err.message });
      }
    }
  }

  // Create indexes (safe — createIndexes is idempotent).
  const indexTargets = [MILESTONE_COLLECTION, EVIDENCE_COLLECTION, HISTORY_COLLECTION];
  for (const name of indexTargets) {
    const defs = REQUIRED_INDEXES[name];
    if (defs?.length) {
      const models = defs.map((d) => ({
        key: d.keys,
        name: d.name,
        ...d.options,
      }));
      await db.collection(name).createIndexes(models);
      logger.info?.("[migration:005] Indexes created", { collectionName: name, count: models.length });
    }
  }

  logger.info?.("[migration:005] Expand stage complete");
}

/**
 * Stage 2 — Backfill: migrate existing milestone data from two sources:
 *   1. Existing bare-bones milestone documents in the milestones collection.
 *   2. Legacy embedded `milestones` arrays on payout documents.
 *
 * Tracks processed milestoneIds in a checkpoint so the migration is
 * idempotent and resumable after interruption.
 */
async function stageBackfill({ db, logger, checkpoint, saveCheckpoint }) {
  let processed = checkpoint?.backfilled ?? 0;
  let skipped = checkpoint?.skipped ?? 0;
  let errors = checkpoint?.errors ?? [];

  // ── Source A: existing milestones collection ───────────────────────────
  const milestonesColl = db.collection(MILESTONE_COLLECTION);
  const alreadyProcessed = new Set(checkpoint?.processedIds ?? []);

  const existingDocs = await milestonesColl.find({}).toArray();
  for (const doc of existingDocs) {
    if (alreadyProcessed.has(doc.milestoneId || doc._id)) continue;

    try {
      // If the doc already has the new fields (evidenceIds, version, etc.),
      // skip it (already migrated).
      if (doc.version && doc.evidenceIds !== undefined) {
        alreadyProcessed.add(doc.milestoneId || doc._id);
        processed += 1;
        continue;
      }

      const normalised = normaliseMilestone(
        doc,
        doc.payoutId || null,
        doc.escrowId,
      );

      if (!normalised) {
        skipped += 1;
        errors.push({ id: doc._id, reason: "malformed source document", collection: MILESTONE_COLLECTION });
        continue;
      }

      // Use the existing _id so the document is replaced in-place.
      await milestonesColl.replaceOne(
        { _id: doc._id },
        { ...normalised, _id: doc._id },
        { upsert: false },
      );

      alreadyProcessed.add(normalised.milestoneId);
      processed += 1;
    } catch (err) {
      skipped += 1;
      errors.push({ id: doc._id, reason: err.message, collection: MILESTONE_COLLECTION });
    }
  }

  // ── Source B: legacy embedded milestones on payouts ────────────────────
  const payoutsColl = db.collection(PAYOUT_COLLECTION);
  const cursor = payoutsColl.find({
    milestones: { $exists: true, $ne: null, $type: "array" },
  });

  for await (const payout of cursor) {
    if (!Array.isArray(payout.milestones) || payout.milestones.length === 0) continue;

    for (const raw of payout.milestones) {
      const legacyId = raw.milestoneId || raw.id;
      if (!legacyId) {
        skipped += 1;
        errors.push({ id: payout._id, reason: "legacy milestone missing identifier", collection: PAYOUT_COLLECTION });
        continue;
      }

      if (alreadyProcessed.has(legacyId)) continue;

      try {
        // Check if already exists in normalised collection.
        const existing = await milestonesColl.findOne({ milestoneId: legacyId });
        if (existing) {
          alreadyProcessed.add(legacyId);
          processed += 1;
          continue;
        }

        const normalised = normaliseMilestone(raw, payout.payoutId, payout.escrowId);
        if (!normalised) {
          skipped += 1;
          errors.push({ id: legacyId, reason: "malformed legacy milestone", collection: PAYOUT_COLLECTION });
          continue;
        }

        await milestonesColl.insertOne(normalised);
        alreadyProcessed.add(legacyId);
        processed += 1;
      } catch (err) {
        if (err?.code === 11000) {
          // Duplicate key — already migrated by another worker.
          alreadyProcessed.add(legacyId);
          processed += 1;
        } else {
          skipped += 1;
          errors.push({ id: legacyId, reason: err.message, collection: PAYOUT_COLLECTION });
        }
      }
    }
  }

  // ── Save checkpoint ────────────────────────────────────────────────────
  const nextCheckpoint = {
    phase: "backfill",
    backfilled: processed,
    skipped,
    errors: errors.slice(0, 1000), // cap to avoid bloating the checkpoint doc
    processedIds: [...alreadyProcessed].slice(0, 10000), // cap
    updatedAt: new Date(),
  };

  await saveCheckpoint(nextCheckpoint);

  logger.info?.("[migration:005] Backfill stage complete", {
    processed,
    skipped,
    errorCount: errors.length,
  });

  return { processed, skipped, errors };
}

/**
 * Stage 3 — Verify: count and sum-check source vs. target.
 */
async function stageVerify({ db, logger }) {
  const milestonesColl = db.collection(MILESTONE_COLLECTION);
  const payoutsColl = db.collection(PAYOUT_COLLECTION);

  // Count milestones in the normalised collection.
  const normalisedCount = await milestonesColl.countDocuments({});

  // Count milestones that existed or exist as embedded arrays on payouts.
  let legacyCount = 0;
  const payoutsWithMilestones = payoutsColl.find({
    milestones: { $exists: true, $ne: null, $type: "array" },
  });
  for await (const payout of payoutsWithMilestones) {
    legacyCount += (payout.milestones || []).length;
  }

  // Sum-check: total milestone amounts vs. payout amounts.
  // Aggregation on the normalised collection.
  let normalisedTotal = "0";
  try {
    const aggResult = await milestonesColl.aggregate([
      { $match: { amount: { $exists: true, $ne: null } } },
      { $group: { _id: null, total: { $sum: { $toDecimal: "$amount" } } } },
    ]).toArray();
    normalisedTotal = aggResult[0]?.total?.toString() || "0";
  } catch {
    // If amount fields are not all numeric, the $toDecimal will fail.
    // Fall back to string summation.
    logger.warn?.("[migration:005] Decimal aggregation failed, falling back to string parse");
    const allDocs = await milestonesColl.find({ amount: { $exists: true, $ne: null } }, { projection: { amount: 1 } }).toArray();
    normalisedTotal = String(allDocs.reduce((sum, d) => sum + Number(d.amount || 0), 0));
  }

  // Sum-check on legacy.
  let legacyTotal = "0";
  const legacyPayouts = payoutsColl.find({
    milestones: { $exists: true, $ne: null, $type: "array" },
  });
  for await (const payout of legacyPayouts) {
    for (const m of (payout.milestones || [])) {
      legacyTotal = String(Number(legacyTotal) + Number(m.amount || 0));
    }
  }

  const checks = {
    normalisedCount,
    legacyCount,
    normalisedTotal,
    legacyTotal,
  };

  logger.info?.("[migration:005] Verify stage results", checks);

  // Fail loudly on mismatches.
  if (normalisedCount < legacyCount) {
    throw new Error(
      `Verification FAILED: normalised count (${normalisedCount}) < legacy count (${legacyCount}). ` +
      "Some milestones were not migrated.",
    );
  }

  // Only compare totals if there are legacy amounts.
  if (legacyTotal !== "0" && normalisedTotal !== legacyTotal) {
    throw new Error(
      `Verification FAILED: total amount mismatch — normalised ${normalisedTotal} vs legacy ${legacyTotal}.`,
    );
  }

  logger.info?.("[migration:005] Verify stage PASSED");
  return checks;
}

// ── exports (for testing) ─────────────────────────────────────────────────────

export { normaliseMilestone, stageExpand, stageBackfill, stageVerify };

// ── migration export ─────────────────────────────────────────────────────────

const migration = {
  version: 5,
  name: "normalize-payout-milestones",
  description:
    "Expands the milestones collection with full document model, adds milestone_evidence and " +
    "milestone_history collections, backfills legacy embedded milestones, and verifies consistency.",

  async up({ db, logger = console, getCheckpoint, saveCheckpoint, clearCheckpoint }) {
    const existingCheckpoint = (await getCheckpoint()) || {};
    const phase = existingCheckpoint.phase || null;

    // Expand — run once, no checkpoint needed (idempotent).
    if (!phase || phase === "expand") {
      logger.info?.("[migration:005] Starting expand stage");
      await stageExpand({ db, logger });
      await saveCheckpoint({ phase: "backfill", backfilled: 0, skipped: 0, errors: [], processedIds: [], updatedAt: new Date() });
    }

    // Backfill — checkpoint-driven, resumable.
    const backfillCheckpoint = await getCheckpoint();
    if (backfillCheckpoint?.phase === "backfill") {
      logger.info?.("[migration:005] Starting backfill stage");
      await stageBackfill({ db, logger, checkpoint: backfillCheckpoint, saveCheckpoint });
    }

    // Verify — runs after backfill completes.
    logger.info?.("[migration:005] Starting verify stage");
    await stageVerify({ db, logger });

    await clearCheckpoint();
    logger.info?.("[migration:005] Migration complete");
  },

  async down({ db, logger = console }) {
    // Remove new collections.
    for (const name of [EVIDENCE_COLLECTION, HISTORY_COLLECTION]) {
      if (await collectionExists(db, name)) {
        await db.collection(name).drop();
        logger.info?.("[migration:005] Dropped collection", { collectionName: name });
      }
    }

    // Remove enhanced indexes from milestones (the base ones from migration 001 stay).
    const extraIndexes = [
      "milestones_payout_id",
      "milestones_payout_order_unique",
      "milestones_status_payout",
    ];
    const milestonesColl = db.collection(MILESTONE_COLLECTION);
    for (const indexName of extraIndexes) {
      try {
        await milestonesColl.dropIndex(indexName);
        logger.info?.("[migration:005] Dropped index", { indexName });
      } catch {
        // May not exist.
      }
    }

    logger.info?.("[migration:005] Rollback complete");
  },
};

export default migration;
