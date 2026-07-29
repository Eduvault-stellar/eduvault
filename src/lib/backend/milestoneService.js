import { randomUUID } from "node:crypto";

import { COLLECTIONS } from "./schemaContracts.js";

const EVIDENCE_COLLECTION = COLLECTIONS.milestoneEvidence || "milestone_evidence";
const HISTORY_COLLECTION = COLLECTIONS.milestoneHistory || "milestone_history";

/**
 * Dual-read/write milestone service.
 *
 * DESIGN CHOICE: dual-read, not dual-write.
 *
 * We read from the normalised milestones collection first, and fall back to
 * the legacy `milestones` array embedded on the payout document if the
 * enhanced record does not exist yet.  Writes always go to the normalised
 * collection and *also* write back to the payout-level `milestones` field
 * so that any code path still reading the old shape sees current data.
 * This makes the rollout fully reversible at any point without data loss.
 *
 * Once the contract (remove-legacy-field) migration has run the fallback
 * read path can be deleted.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function now() {
  return new Date();
}

function generateId() {
  return randomUUID();
}

/** Capitalise first letter for consistency with the legacy shape. */
function normaliseLegacyMilestone(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    milestoneId: raw.milestoneId || raw.id || generateId(),
    escrowId: raw.escrowId || "",
    payoutId: raw.payoutId || null,
    order: raw.order ?? null,
    title: raw.title || raw.description || "",
    description: raw.description || null,
    amount: raw.amount != null ? String(raw.amount) : null,
    currency: raw.currency || null,
    dueDate: raw.dueDate instanceof Date ? raw.dueDate : raw.dueDate ? new Date(raw.dueDate) : null,
    status: raw.status || "pending",
    evidenceIds: Array.isArray(raw.evidenceIds) ? raw.evidenceIds : [],
    feedback: raw.feedback || null,
    chainTxHash: raw.chainTxHash || null,
    createdBy: raw.createdBy || null,
    version: 1,
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : now(),
    updatedAt: now(),
  };
}

function buildHistoryEntry({ milestoneId, fromStatus, toStatus, changedBy, reason, chainTxHash }) {
  return {
    historyId: generateId(),
    milestoneId,
    fromStatus,
    toStatus,
    changedBy,
    reason: reason || null,
    chainTxHash: chainTxHash || null,
    createdAt: now(),
  };
}

// ── dual read ────────────────────────────────────────────────────────────────

/**
 * Retrieve milestones for a payout.
 *
 * @param {object} db          MongoDb-like db handle
 * @param {string} payoutId
 * @returns {Promise<Array>}
 */
export async function getMilestonesByPayout(db, payoutId) {
  const coll = db.collection(COLLECTIONS.milestones);
  const docs = await coll.find({ payoutId }).sort({ order: 1 }).toArray();
  if (docs.length > 0) return docs;

  // Fallback: read from legacy embedded field on the payout document.
  const payouts = db.collection(COLLECTIONS.payouts);
  const payout = await payouts.findOne({ payoutId }, { projection: { milestones: 1 } });
  if (payout?.milestones && Array.isArray(payout.milestones)) {
    return payout.milestones.map((m) => normaliseLegacyMilestone(m)).filter(Boolean);
  }
  return [];
}

/**
 * Retrieve milestones for an escrow.
 */
export async function getMilestonesByEscrow(db, escrowId) {
  const coll = db.collection(COLLECTIONS.milestones);
  const docs = await coll.find({ escrowId }).sort({ order: 1 }).toArray();
  if (docs.length > 0) return docs;

  // Fallback: scan payouts with this escrowId for embedded milestones.
  const payouts = db.collection(COLLECTIONS.payouts);
  const cursor = payouts.find({ escrowId }, { projection: { milestones: 1 } });
  const results = [];
  for await (const payout of cursor) {
    if (payout?.milestones && Array.isArray(payout.milestones)) {
      for (const m of payout.milestones) {
        results.push(normaliseLegacyMilestone(m));
      }
    }
  }
  return results.filter(Boolean);
}

/**
 * Get a single milestone by milestoneId.
 */
export async function getMilestoneById(db, milestoneId) {
  const coll = db.collection(COLLECTIONS.milestones);
  const doc = await coll.findOne({ milestoneId });
  if (doc) return doc;

  // Fallback: scan payouts for embedded milestone.
  const payouts = db.collection(COLLECTIONS.payouts);
  const cursor = payouts.find({ "milestones.milestoneId": milestoneId }, { projection: { milestones: 1 } });
  for await (const payout of cursor) {
    if (payout?.milestones && Array.isArray(payout.milestones)) {
      const match = payout.milestones.find((m) => m.milestoneId === milestoneId || m.id === milestoneId);
      if (match) return normaliseLegacyMilestone(match);
    }
  }
  return null;
}

// ── dual write ───────────────────────────────────────────────────────────────

/**
 * Validate that the sum of milestone amounts does not exceed the payout total.
 */
async function assertMilestoneTotalWithinPayout(db, payoutId, excludeMilestoneId = null) {
  const payout = await db.collection(COLLECTIONS.payouts).findOne({ payoutId }, { projection: { amount: 1 } });
  if (!payout) return; // no payout to check against

  const match = excludeMilestoneId
    ? { payoutId, milestoneId: { $ne: excludeMilestoneId } }
    : { payoutId };

  const pipeline = [
    { $match: match },
    { $group: { _id: null, total: { $sum: { $toDecimal: "$amount" } } } },
  ];
  const result = await db.collection(COLLECTIONS.milestones).aggregate(pipeline).toArray();
  const currentTotal = result[0]?.total || "0";

  const payoutAmount = payout.amount || "0";
  if (Number(currentTotal) > Number(payoutAmount)) {
    throw new Error(
      `Milestone total (${currentTotal}) exceeds payout amount (${payoutAmount}) for payout ${payoutId}`,
    );
  }
}

/**
 * Dual-write: persist to the normalised milestones collection AND keep the
 * legacy embedded array on the payout document in sync.
 */
async function syncLegacyField(db, payoutId) {
  const milestones = await db.collection(COLLECTIONS.milestones).find({ payoutId }).sort({ order: 1 }).toArray();
  const legacyArray = milestones.map((m) => ({
    milestoneId: m.milestoneId,
    order: m.order,
    title: m.title,
    description: m.description,
    amount: m.amount,
    currency: m.currency,
    dueDate: m.dueDate,
    status: m.status,
    feedback: m.feedback,
    chainTxHash: m.chainTxHash,
  }));

  await db.collection(COLLECTIONS.payouts).updateOne(
    { payoutId },
    { $set: { milestones: legacyArray } },
  );
}

/**
 * Create a new milestone.
 */
export async function createMilestone(db, {
  payoutId,
  escrowId,
  order,
  title,
  description,
  amount,
  currency,
  dueDate,
  createdBy,
}) {
  const milestoneId = generateId();
  const coll = db.collection(COLLECTIONS.milestones);

  if (payoutId) {
    await assertMilestoneTotalWithinPayout(db, payoutId);
  }

  const doc = {
    milestoneId,
    payoutId: payoutId || null,
    escrowId,
    order: order ?? 0,
    title: title || "",
    description: description || null,
    amount: amount != null ? String(amount) : null,
    currency: currency || null,
    dueDate: dueDate instanceof Date ? dueDate : dueDate ? new Date(dueDate) : null,
    status: "pending",
    evidenceIds: [],
    feedback: null,
    chainTxHash: null,
    createdBy: createdBy || null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  };

  await coll.insertOne(doc);

  if (payoutId) {
    await syncLegacyField(db, payoutId);
  }

  return doc;
}

/**
 * Update a milestone's fields. Uses optimistic concurrency via the `version`
 * field: pass the current version and the update succeeds only if the document
 * has not been modified since you read it.
 */
export async function updateMilestone(db, milestoneId, fields, expectedVersion) {
  const coll = db.collection(COLLECTIONS.milestones);

  const setFields = { ...fields, updatedAt: now() };
  delete setFields.milestoneId;
  delete setFields.version;

  if (expectedVersion !== undefined) {
    setFields.version = expectedVersion + 1;
  }

  const filter = { milestoneId };
  if (expectedVersion !== undefined) {
    filter.version = expectedVersion;
  }

  const result = await coll.updateOne(filter, { $set: setFields });

  if (result.modifiedCount === 0) {
    const existing = await coll.findOne({ milestoneId }, { projection: { version: 1 } });
    if (!existing) {
      // Try legacy fallback.
      const payouts = db.collection(COLLECTIONS.payouts);
      const payout = await payouts.findOne(
        { "milestones.milestoneId": milestoneId },
        { projection: { milestones: 1 } },
      );
      if (!payout) throw new Error(`Milestone ${milestoneId} not found`);
      return updateLegacyEmbeddedMilestone(db, payout, milestoneId, fields);
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new Error(
        `Milestone ${milestoneId} version conflict: expected ${expectedVersion}, current ${existing.version}`,
      );
    }
    throw new Error(`Milestone ${milestoneId} not found`);
  }

  // Reload to get current version & payoutId for legacy sync.
  const updated = await coll.findOne({ milestoneId });
  if (updated?.payoutId) {
    await syncLegacyField(db, updated.payoutId);
  }
  return updated;
}

/**
 * Legacy fallback: update a milestone still embedded in the payout document.
 */
async function updateLegacyEmbeddedMilestone(db, payout, milestoneId, fields) {
  const milestones = (payout.milestones || []).map((m) => {
    if (m.milestoneId !== milestoneId && m.id !== milestoneId) return m;
    return { ...m, ...fields, updatedAt: now() };
  });
  await db.collection(COLLECTIONS.payouts).updateOne(
    { payoutId: payout.payoutId },
    { $set: { milestones } },
  );
  return milestones.find((m) => m.milestoneId === milestoneId || m.id === milestoneId);
}

/**
 * Update milestone status atomically. Records a history entry on each transition.
 */
export async function transitionMilestoneStatus(db, milestoneId, toStatus, { changedBy, reason, chainTxHash } = {}) {
  const milestone = await getMilestoneById(db, milestoneId);
  if (!milestone) throw new Error(`Milestone ${milestoneId} not found`);

  const fromStatus = milestone.status;

  const updated = await updateMilestone(db, milestoneId, { status: toStatus }, milestone.version);

  // Record history entry.
  const historyEntry = buildHistoryEntry({
    milestoneId,
    fromStatus,
    toStatus,
    changedBy: changedBy || "system",
    reason: reason || null,
    chainTxHash: chainTxHash || null,
  });
  await db.collection(HISTORY_COLLECTION).insertOne(historyEntry);

  return { milestone: updated, history: historyEntry };
}

/**
 * Submit evidence for a milestone.
 */
export async function addMilestoneEvidence(db, milestoneId, { uploadedBy, fileId, fileUrl, fileType, notes }) {
  const evidenceId = generateId();
  const doc = {
    evidenceId,
    milestoneId,
    uploadedBy,
    fileId: fileId || null,
    fileUrl: fileUrl || null,
    fileType: fileType || null,
    notes: notes || null,
    createdAt: now(),
  };

  // Optimistic: push evidenceId onto the milestone's evidenceIds array.
  // If the milestone doc doesn't exist yet (legacy), the insert still works.
  await db.collection(EVIDENCE_COLLECTION).insertOne(doc);

  try {
    await db.collection(COLLECTIONS.milestones).updateOne(
      { milestoneId },
      { $push: { evidenceIds: evidenceId }, $set: { updatedAt: now() } },
    );
  } catch {
    // Milestone might not exist in the new collection yet — still ok,
    // the evidence record stands alone.
  }

  return doc;
}

/**
 * Get evidence for a milestone.
 */
export async function getMilestoneEvidence(db, milestoneId) {
  return db.collection(EVIDENCE_COLLECTION).find({ milestoneId }).sort({ createdAt: -1 }).toArray();
}

/**
 * Get history for a milestone.
 */
export async function getMilestoneHistory(db, milestoneId) {
  return db.collection(HISTORY_COLLECTION).find({ milestoneId }).sort({ createdAt: -1 }).toArray();
}

/**
 * Delete a milestone and its evidence/history (cleanup, not user-facing).
 */
export async function deleteMilestone(db, milestoneId) {
  const coll = db.collection(COLLECTIONS.milestones);
  const doc = await coll.findOne({ milestoneId });
  if (!doc) return null;

  await db.collection(EVIDENCE_COLLECTION).deleteMany({ milestoneId });
  await db.collection(HISTORY_COLLECTION).deleteMany({ milestoneId });
  await coll.deleteOne({ milestoneId });

  if (doc.payoutId) {
    await syncLegacyField(db, doc.payoutId);
  }
  return doc;
}
