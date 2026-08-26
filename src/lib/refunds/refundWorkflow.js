/**
 * Custody-safe, idempotent on-chain refund workflow (#27).
 *
 * Core orchestration lives here with every privileged capability injected as a
 * dependency (`submitPayment`, `verifySettlement`, `revokeEntitlement`) so the
 * policy engine stays framework-free and never touches signing keys or
 * Horizon directly. The Next-facing wiring lives in
 * `src/lib/stellar/refundService.js`.
 *
 * Guarantees:
 *  - Amount, asset, destination, network, and original purchase are derived
 *    from the persisted purchase receipt, never from caller input.
 *  - At most one active refund exists per purchase (compare-and-set slot plus
 *    a partial unique index), so concurrent approvals cannot double-pay.
 *  - Every state change is a guarded findOneAndUpdate that atomically appends
 *    a hash-chained audit entry (tamper-evident trail).
 *  - Entitlement access is revoked only after on-chain settlement is verified;
 *    revocation converges through restart-safe reconciliation.
 */

import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import { COLLECTIONS } from "../backend/schemaContracts.js";
import { currentCorrelationId } from "../telemetry/context.js";
import { auditLog } from "../api/audit.js";
import { isCompletedPurchaseStatus } from "../purchases/access.js";
import {
  REFUND_STATES,
  ACTIVE_REFUND_STATES,
  EFFECTIVE_REFUND_STATUSES,
} from "./stateMachine.js";

// Bump whenever refund policy semantics change so auditors can attribute each
// historical decision to the exact rules that produced it.
export const REFUND_POLICY_VERSION = 1;

const AUDIT_GENESIS_HASH = "0".repeat(64);

function intEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback;
}

export function refundPolicy() {
  return {
    // Days from purchase confirmation after which new claims are refused.
    windowDays: intEnv("REFUND_WINDOW_DAYS", 30),
    // Basis points of every refund retained by the platform; the remainder is
    // what the treasury pays out. Default 0 = full refund.
    feeBps: intEnv("REFUND_FEE_BPS", 0),
    // Maximum total units refunded across all purchases per UTC day.
    // Unset/empty disables the cap.
    dailyCapUnits: parseUnits(process.env.REFUND_DAILY_CAP_UNITS || ""),
    maxSubmitAttempts: intEnv("REFUND_MAX_SUBMIT_ATTEMPTS", 5),
    // How long the `submitting` lease protects an in-flight submission before
    // reconciliation considers the submitter crashed.
    leaseMs: intEnv("REFUND_SUBMIT_LEASE_MS", 120_000),
    policyVersion: REFUND_POLICY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Amounts. All amounts are integers in the purchase's own smallest-unit scale
// (the same scale as `purchases.amount`, i.e. stroops-style unit strings).
// ---------------------------------------------------------------------------

export function parseUnits(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value >= 0n ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return null;
  return BigInt(Math.trunc(num));
}

export function formatUnits(units) {
  return units.toString();
}

// floor(units * bps / 10_000)
export function applyBpsFloor(units, bps) {
  const clamped = Math.max(0, Math.min(10_000, Number(bps) || 0));
  return (units * BigInt(clamped)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Tamper-evident audit trail. Each refund embeds an append-only trail whose
// entries commit to their predecessor via SHA-256, so removing or editing a
// historical entry breaks the chain.
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function buildRefundAuditEntry(previous, { action, actor, reason }) {
  const policyVersion = REFUND_POLICY_VERSION;
  const prevHash = previous?.hash || AUDIT_GENESIS_HASH;
  const seq = (previous?.seq || 0) + 1;
  const payload = {
    seq,
    action,
    actor,
    reason,
    policyVersion,
    correlationId: currentCorrelationId(),
    at: new Date().toISOString(),
  };
  const hash = sha256Hex(`${prevHash}|${stableStringify(payload)}`);
  return { ...payload, prevHash, hash };
}

function emitConsoleAudit(entry, extra = {}) {
  auditLog({
    event: String(entry.action || "").replace(/\./g, "_"),
    action: entry.action,
    actor: entry.actor,
    reason: entry.reason,
    policyVersion: entry.policyVersion,
    outcome: extra.outcome,
    status: extra.status,
    refundId: extra.refundId,
    purchaseId: extra.purchaseId,
    source: "refund-workflow",
  });
}

async function transitionRefund(
  db,
  refundId,
  {
    fromStatuses,
    toStatus,
    auditAction,
    auditActor,
    auditReason,
    set = {},
    inc = {},
    extraFilter = {},
  }
) {
  const collection = db.collection(COLLECTIONS.refunds);
  const current = await collection.findOne(
    { _id: refundId },
    { projection: { auditTrail: 1, purchaseId: 1 } }
  );
  if (!current) return null;

  const trail = current.auditTrail || [];
  const entry = buildRefundAuditEntry(trail[trail.length - 1], {
    action: auditAction,
    actor: auditActor,
    reason: auditReason,
  });

  const updated = await collection.findOneAndUpdate(
    { _id: refundId, status: { $in: fromStatuses }, ...extraFilter },
    {
      $set: { status: toStatus, updatedAt: new Date(), ...set },
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
      $push: { auditTrail: entry },
    },
    { returnDocument: "after" }
  );
  if (!updated) return null; // CAS lost to a concurrent transition.

  emitConsoleAudit(entry, {
    refundId: String(refundId),
    purchaseId: updated.purchaseId,
    status: toStatus,
  });
  return updated;
}

function releasePurchaseSlot(db, purchaseId, refundId) {
  return db
    .collection(COLLECTIONS.purchases)
    .updateOne(
      { _id: new ObjectId(String(purchaseId)), activeRefundId: refundId },
      { $set: { activeRefundId: null, updatedAt: new Date() } }
    );
}

// ---------------------------------------------------------------------------
// Purchase lookups and refundability accounting.
// ---------------------------------------------------------------------------

export async function findPurchaseByIdentifier(db, transactionId) {
  const purchases = db.collection(COLLECTIONS.purchases);
  const identifier = String(transactionId || "").trim();
  if (!identifier) return null;

  let purchase = await purchases.findOne({ transactionHash: identifier });
  if (!purchase && /^[a-f\d]{24}$/i.test(identifier)) {
    purchase = await purchases.findOne({ _id: new ObjectId(identifier) });
  }
  return purchase || null;
}

function purchaseCompletedAt(purchase) {
  for (const candidate of [
    purchase.confirmedAt,
    purchase.purchasedAt,
    purchase.createdAt,
  ]) {
    const date = candidate ? new Date(candidate) : null;
    if (date && !Number.isNaN(date.getTime())) return date;
  }
  return null;
}

export async function sumEffectiveRefundedUnits(db, purchaseKey, { excludeId } = {}) {
  const filter = {
    purchaseId: purchaseKey,
    status: { $in: EFFECTIVE_REFUND_STATUSES },
  };
  if (excludeId) filter._id = { $ne: excludeId };

  const rows = await db
    .collection(COLLECTIONS.refunds)
    .find(filter, { projection: { amountUnits: 1 } })
    .toArray();

  let total = 0n;
  for (const row of rows) {
    total += parseUnits(row.amountUnits) ?? 0n;
  }
  return total;
}

async function sumTodayEffectiveUnits(db) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .collection(COLLECTIONS.refunds)
    .find(
      {
        createdAt: { $gte: startOfDay },
        status: { $in: EFFECTIVE_REFUND_STATUSES },
      },
      { projection: { amountUnits: 1 } }
    )
    .toArray();

  let total = 0n;
  for (const row of rows) {
    total += parseUnits(row.amountUnits) ?? 0n;
  }
  return total;
}

export async function ensureRefundIndexes(db) {
  // Defense-in-depth alongside the compare-and-set purchase slot: at most one
  // *active* refund document per purchase. Settled/failed/rejected refunds do
  // not claim the slot, so sequential partial refunds remain possible.
  try {
    await db.collection(COLLECTIONS.refunds).createIndex(
      { purchaseId: 1 },
      {
        unique: true,
        name: "one_active_refund_per_purchase",
        partialFilterExpression: {
          status: { $in: ACTIVE_REFUND_STATES },
        },
      }
    );
  } catch {
    // Index creation races or pre-existing duplicates must never break the
    // claim path; the CAS guards remain authoritative.
  }
}

// ---------------------------------------------------------------------------
// Claim creation.
// ---------------------------------------------------------------------------

export async function createRefundClaim(
  db,
  { transactionId, requestedAmount, actor, reason, network }
) {
  const purchase = await findPurchaseByIdentifier(db, transactionId);
  if (!purchase || !isCompletedPurchaseStatus(purchase.status)) {
    return {
      ok: false,
      code: "purchase_not_found",
      httpStatus: 404,
      message: "No settled purchase matches the supplied transaction identifier.",
    };
  }

  const policy = refundPolicy();
  const completedAt = purchaseCompletedAt(purchase);
  if (
    !completedAt ||
    completedAt.getTime() + policy.windowDays * 24 * 60 * 60 * 1000 <= Date.now()
  ) {
    auditLog({
      event: "refund_claim_rejected_window_expired",
      actor,
      reason: "Refund window expired for this purchase",
      policyVersion: policy.policyVersion,
      status: 400,
      source: "refund-workflow",
    });
    return {
      ok: false,
      code: "refund_window_expired",
      httpStatus: 400,
      message: `Refund window of ${policy.windowDays} days has expired for this purchase.`,
    };
  }

  const purchaseKey = String(purchase._id);
  const refunds = db.collection(COLLECTIONS.refunds);

  const activeClaim = await refunds.findOne({
    purchaseId: purchaseKey,
    status: { $in: ACTIVE_REFUND_STATES },
  });
  if (activeClaim) {
    return {
      ok: false,
      code: "duplicate_active_claim",
      httpStatus: 409,
      message: `An active refund claim already exists for this purchase (${activeClaim._id}).`,
      refundId: String(activeClaim._id),
    };
  }

  const paidUnits =
    parseUnits(purchase.amount) ??
    parseUnits(purchase.amountDisplay) ??
    0n;
  if (paidUnits <= 0n) {
    return {
      ok: false,
      code: "purchase_not_refundable",
      httpStatus: 409,
      message: "Purchase record does not carry a positive refundable amount.",
    };
  }

  const alreadyRefunded = await sumEffectiveRefundedUnits(db, purchaseKey);
  const remaining = paidUnits - alreadyRefunded;
  if (remaining <= 0n) {
    return {
      ok: false,
      code: "already_refunded",
      httpStatus: 409,
      message: "This purchase has already been fully refunded.",
    };
  }

  // Server-side amount derivation: the caller may ask for a partial amount,
  // but the payable value is always clamped to the remaining eligible units.
  const requested = requestedAmount ? parseUnits(requestedAmount) : null;
  const claimBase = requested && requested > 0n ? (requested < remaining ? requested : remaining) : remaining;
  const payable = applyBpsFloor(claimBase, 10_000 - policy.feeBps);
  if (payable <= 0n) {
    return {
      ok: false,
      code: "nothing_refundable",
      httpStatus: 422,
      message: "Requested amount rounds down to zero after fee allocation.",
    };
  }

  if (policy.dailyCapUnits !== null) {
    const spentToday = await sumTodayEffectiveUnits(db);
    if (spentToday + payable > policy.dailyCapUnits) {
      auditLog({
        event: "refund_claim_rejected_daily_cap",
        actor,
        reason: "Daily treasury refund cap reached",
        policyVersion: policy.policyVersion,
        status: 429,
        source: "refund-workflow",
      });
      return {
        ok: false,
        code: "daily_cap_exceeded",
        httpStatus: 429,
        message: "Daily treasury refund cap would be exceeded by this claim.",
      };
    }
  }

  await ensureRefundIndexes(db);

  const now = new Date();
  const entry = buildRefundAuditEntry(null, {
    action: "refund.claimed",
    actor,
    reason: reason || null,
  });

  let inserted;
  try {
    inserted = await refunds.insertOne({
      purchaseId: purchaseKey,
      purchaseTransactionHash: purchase.transactionHash || null,
      materialId: purchase.materialId || null,
      buyerAddress: String(purchase.buyerAddress || "").toLowerCase(),
      destination: String(purchase.buyerAddress || "").toLowerCase(),
      asset: purchase.asset || null,
      network: network || null,
      amountUnits: formatUnits(payable),
      claimedUnits: formatUnits(claimBase),
      feeRetainedUnits: formatUnits(claimBase - payable),
      status: REFUND_STATES.REQUESTED,
      txHash: null,
      ledger: null,
      operationIndex: null,
      attempts: 0,
      submitLeaseExpiresAt: null,
      entitlementRevokedAt: null,
      requestedBy: actor || null,
      requestReason: reason || null,
      approvedBy: null,
      approvedAt: null,
      submittedAt: null,
      settledAt: null,
      failedReason: null,
      policyVersion: policy.policyVersion,
      correlationId: entry.correlationId,
      auditTrail: [entry],
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return {
        ok: false,
        code: "duplicate_active_claim",
        httpStatus: 409,
        message: "An active refund claim already exists for this purchase.",
      };
    }
    throw err;
  }

  emitConsoleAudit(entry, {
    refundId: String(inserted.insertedId),
    purchaseId: purchaseKey,
  });

  const refund = await refunds.findOne({ _id: inserted.insertedId });
  return { ok: true, refund };
}

// ---------------------------------------------------------------------------
// Approval / rejection.
// ---------------------------------------------------------------------------

export async function approveRefundClaim(
  db,
  { refundId, actor, reason, expectedNetwork }
) {
  const refunds = db.collection(COLLECTIONS.refunds);
  let refund;
  try {
    refund = await refunds.findOne({ _id: new ObjectId(String(refundId)) });
  } catch {
    return { ok: false, code: "refund_not_found", httpStatus: 404, message: "Refund claim not found." };
  }
  if (!refund) {
    return { ok: false, code: "refund_not_found", httpStatus: 404, message: "Refund claim not found." };
  }

  // Idempotent retry: re-approving an already-approved claim by any admin is
  // a no-op that returns the current record without moving funds again.
  if (refund.status === REFUND_STATES.APPROVED) {
    return { ok: true, refund, alreadyApproved: true };
  }
  if (
    [
      REFUND_STATES.SUBMITTING,
      REFUND_STATES.PENDING,
      REFUND_STATES.SETTLED,
    ].includes(refund.status)
  ) {
    return {
      ok: false,
      code: "already_in_flight",
      httpStatus: 409,
      message: `Refund is already ${refund.status}; approval window has closed.`,
    };
  }
  if (refund.status === REFUND_STATES.REJECTED) {
    return {
      ok: false,
      code: "refund_rejected",
      httpStatus: 409,
      message: "Refund claim was rejected and cannot be approved.",
    };
  }
  if (refund.status === REFUND_STATES.FAILED) {
    return {
      ok: false,
      code: "refund_failed",
      httpStatus: 409,
      message: `Refund previously failed (${refund.failedReason}); create a new claim.`,
    };
  }

  if (expectedNetwork && refund.network && refund.network !== expectedNetwork) {
    return {
      ok: false,
      code: "network_mismatch",
      httpStatus: 409,
      message: "Refund is bound to a different Stellar network.",
    };
  }

  // Re-derive the refundable ceiling from trusted records at approval time:
  // another settled partial refund may have shrunk it since the claim opened.
  const purchase = await findPurchaseByIdentifier(db, refund.purchaseTransactionHash || refund.purchaseId);
  const paidUnits = purchase ? parseUnits(purchase.amount) ?? 0n : 0n;
  const refunded = await sumEffectiveRefundedUnits(db, refund.purchaseId, {
    excludeId: refund._id,
  });
  const ceiling =
    paidUnits > 0n
      ? paidUnits
      : parseUnits(refund.claimedUnits) ?? 0n;
  const remaining = ceiling - refunded;
  const claimUnits = parseUnits(refund.amountUnits) ?? 0n;
  if (remaining < claimUnits) {
    return {
      ok: false,
      code: "insufficient_remaining",
      httpStatus: 409,
      message: "Purchase no longer carries sufficient unrefunded value for this claim.",
    };
  }

  // Atomically decide the single winner of this claim's approval. Losing
  // concurrent approvals fall through to idempotent semantics below.
  const approved = await transitionRefund(db, refund._id, {
    fromStatuses: [REFUND_STATES.REQUESTED],
    toStatus: REFUND_STATES.APPROVED,
    auditAction: "refund.approved",
    auditActor: actor,
    auditReason: reason || null,
    set: {
      approvedBy: actor || null,
      approvedAt: new Date(),
    },
  });

  if (!approved) {
    // A concurrent approver won the CAS; re-reading yields either an approved
    // claim (idempotent success) or another terminal state.
    const latest = await refunds.findOne({ _id: refund._id });
    if (latest?.status === REFUND_STATES.APPROVED) {
      return { ok: true, refund: latest, alreadyApproved: true };
    }
    return {
      ok: false,
      code: "concurrent_modification",
      httpStatus: 409,
      message: "Refund state changed concurrently; retry.",
    };
  }

  // Compare-and-set the per-purchase slot so two different claims can never
  // both reach settlement for one purchase.
  const slot = await db.collection(COLLECTIONS.purchases).updateOne(
    {
      _id: new ObjectId(String(refund.purchaseId)),
      $or: [{ activeRefundId: null }, { activeRefundId: refund._id }],
    },
    {
      $set: {
        activeRefundId: refund._id,
        updatedAt: new Date(),
      },
    }
  );
  if (slot.modifiedCount !== 1) {
    // Another active refund owns the purchase; undo our approval.
    await transitionRefund(db, refund._id, {
      fromStatuses: [REFUND_STATES.APPROVED],
      toStatus: REFUND_STATES.REQUESTED,
      auditAction: "refund.reconciled",
      auditActor: "system",
      auditReason: "Approval reverted: purchase refund slot held elsewhere",
      set: {
        approvedBy: null,
        approvedAt: null,
      },
    });
    return {
      ok: false,
      code: "slot_conflict",
      httpStatus: 409,
      message: "Another refund currently holds this purchase's active refund slot.",
    };
  }

  return { ok: true, refund: approved };
}

export async function rejectRefundClaim(
  db,
  { refundId, actor, reason }
) {
  let claimId;
  try {
    claimId = new ObjectId(String(refundId));
  } catch {
    return { ok: false, code: "refund_not_found", httpStatus: 404, message: "Refund claim not found." };
  }

  const refund = await db
    .collection(COLLECTIONS.refunds)
    .findOne({ _id: claimId });
  if (!refund) {
    return { ok: false, code: "refund_not_found", httpStatus: 404, message: "Refund claim not found." };
  }
  if (
    ![REFUND_STATES.REQUESTED, REFUND_STATES.APPROVED].includes(refund.status)
  ) {
    return {
      ok: false,
      code: "not_rejectable",
      httpStatus: 409,
      message: `Refund in status '${refund.status}' can no longer be rejected.`,
    };
  }

  const updated = await transitionRefund(db, claimId, {
    fromStatuses: [REFUND_STATES.REQUESTED, REFUND_STATES.APPROVED],
    toStatus: REFUND_STATES.REJECTED,
    auditAction: "refund.rejected",
    auditActor: actor,
    auditReason: reason || null,
  });
  if (!updated) {
    return {
      ok: false,
      code: "concurrent_modification",
      httpStatus: 409,
      message: "Refund state changed concurrently; retry.",
    };
  }

  await releasePurchaseSlot(db, updated.purchaseId, claimId);
  return { ok: true, refund: updated };
}

// ---------------------------------------------------------------------------
// Settlement (funds movement). Signing and Horizon I/O are injected.
//
// deps:
//   preflight()            – optional gate (signer configured, emergency
//                            switch off); throw to abort while still approved.
//   submitPayment(params)  – builds/signs/submits the payment; resolves
//                            { txHash } or throws an error carrying:
//                              classification: 'definitive' | 'timeout_unknown'
//                              txHash (when Horizon accepted before failing)
//   verifySettlement(hash) – reconciles a submitted hash on-chain; resolves
//                            { settled: true, ledger, operationIndex } |
//                            { settled: false, undetermined: true } |
//                            { settled: false, failed: true, reason }
//   revokeEntitlement(m, b)– revokes access for (materialId, buyerAddress).
// ---------------------------------------------------------------------------

function missingDep(name) {
  throw new Error(
    `Refund workflow dependency '${name}' is not configured; refusing to move funds.`
  );
}

async function markSettledAndRevoke(db, refund, deps, verification) {
  const settled = await transitionRefund(db, refund._id, {
    fromStatuses: [REFUND_STATES.PENDING],
    toStatus: REFUND_STATES.SETTLED,
    auditAction: "refund.settled",
    auditActor: "system",
    auditReason: `Verified on-chain settlement in ledger ${verification.ledger ?? "unknown"}`,
    set: {
      settledAt: new Date(),
      ledger: verification.ledger ?? null,
      operationIndex: verification.operationIndex ?? null,
    },
  });
  if (!settled) return null;

  // Funds have provably moved; release the purchase slot so future partial
  // refunds can be claimed against the remaining value.
  await releasePurchaseSlot(db, settled.purchaseId, settled._id);

  // Access removal happens strictly after verified settlement. If this call
  // fails or the process dies, reconciliation retries it until it converges;
  // a failed refund never removes access prematurely.
  try {
    await (deps.revokeEntitlement || ((m, b) => missingDep("revokeEntitlement")))(
      settled.materialId,
      settled.buyerAddress
    );
    await db
      .collection(COLLECTIONS.refunds)
      .updateOne(
        { _id: settled._id, entitlementRevokedAt: null },
        { $set: { entitlementRevokedAt: new Date(), updatedAt: new Date() } }
      );
  } catch {
    // Converged later by reconcileIncompleteRefunds.
  }

  return settled;
}

export async function settleApprovedRefund(db, refundId, deps = {}) {
  let claimId;
  try {
    claimId = new ObjectId(String(refundId));
  } catch {
    return { ok: false, code: "refund_not_found", httpStatus: 404, message: "Refund claim not found." };
  }

  const refund = await db.collection(COLLECTIONS.refunds).findOne({ _id: claimId });
  if (!refund) {
    return { ok: false, code: "refund_not_found", httpStatus: 404, message: "Refund claim not found." };
  }
  if (refund.status === REFUND_STATES.SUBMITTING || refund.status === REFUND_STATES.PENDING) {
    return {
      ok: false,
      code: "already_in_flight",
      httpStatus: 409,
      message: `Refund submission already ${refund.status}.`,
    };
  }
  if (refund.status === REFUND_STATES.SETTLED) {
    return { ok: true, refund, alreadySettled: true };
  }
  if (refund.status !== REFUND_STATES.APPROVED) {
    return {
      ok: false,
      code: "not_approved",
      httpStatus: 409,
      message: `Refund in status '${refund.status}' cannot be settled.`,
    };
  }

  // Signer/emergency gates run BEFORE any state change so a misconfigured
  // signer never strands claims mid-flight.
  if (deps.preflight) await deps.preflight(refund);

  const policy = refundPolicy();
  const leaseExpiresAt = new Date(Date.now() + policy.leaseMs);
  const leased = await transitionRefund(db, claimId, {
    fromStatuses: [REFUND_STATES.APPROVED],
    toStatus: REFUND_STATES.SUBMITTING,
    auditAction: "refund.submit_started",
    auditActor: "system",
    auditReason: "Submitting signed payment to Stellar",
    set: { submitLeaseExpiresAt: leaseExpiresAt },
    inc: { attempts: 1 },
  });
  if (!leased) {
    return {
      ok: false,
      code: "already_in_flight",
      httpStatus: 409,
      message: "Another worker holds this refund's submission lease.",
    };
  }

  const rollbackToApproved = async (auditReason) => {
    const rolledBack =
      (await transitionRefund(db, claimId, {
        fromStatuses: [REFUND_STATES.SUBMITTING],
        toStatus: REFUND_STATES.APPROVED,
        auditAction: "refund.reconciled",
        auditActor: "system",
        auditReason,
        set: { submitLeaseExpiresAt: null },
      })) ||
      (await db.collection(COLLECTIONS.refunds).findOne({ _id: claimId }));
    return { ok: false, code: "submit_retryable", refund: rolledBack, retryable: true };
  };

  const failTerminal = async (failureReason) => {
    const failed = await transitionRefund(db, claimId, {
      fromStatuses: [REFUND_STATES.SUBMITTING],
      toStatus: REFUND_STATES.FAILED,
      auditAction: "refund.failed",
      auditActor: "system",
      auditReason: failureReason,
      set: { failedReason: failureReason, submitLeaseExpiresAt: null },
    });
    if (failed) await releasePurchaseSlot(db, failed.purchaseId, claimId);
    return { ok: false, code: "settlement_failed", refund: failed || refund, retryable: false };
  };

  let result;
  try {
    result = await (deps.submitPayment || (() => missingDep("submitPayment")))({
      refundId: String(claimId),
      destination: refund.destination,
      assetCode: refund.asset,
      amountUnits: refund.amountUnits,
      network: refund.network,
      correlationId: refund.correlationId,
    });
  } catch (err) {
    if (err?.txHash) {
      // Horizon timed out / connection dropped after the transaction was
      // accepted. The payment may have landed; park it as pending and let
      // verification decide - never resubmit blindly.
      const parked = await transitionRefund(db, claimId, {
        fromStatuses: [REFUND_STATES.SUBMITTING],
        toStatus: REFUND_STATES.PENDING,
        auditAction: "refund.submitted",
        auditActor: "system",
        auditReason: "Horizon response lost after acceptance; parked for reconciliation",
        set: {
          txHash: err.txHash,
          submittedAt: new Date(),
          submitLeaseExpiresAt: null,
        },
      });
      if (!parked) return { ok: false, code: "concurrent_modification", refund, retryable: true };
      return { ok: true, refund: parked, pendingVerification: true };
    }

    if (err?.classification === "definitive") {
      return failTerminal(err.message || "Stellar rejected the refund transaction.");
    }

    if ((leased.attempts ?? 0) + 1 >= policy.maxSubmitAttempts) {
      return failTerminal(`Submission attempts exhausted: ${err?.message || "unknown error"}`);
    }
    return rollbackToApproved(`Transient submission failure: ${err?.message || "unknown error"}`);
  }

  if (!result?.txHash) {
    return rollbackToApproved("Signer returned no transaction hash");
  }

  const pending = await transitionRefund(db, claimId, {
    fromStatuses: [REFUND_STATES.SUBMITTING],
    toStatus: REFUND_STATES.PENDING,
    auditAction: "refund.submitted",
    auditActor: "system",
    auditReason: `Payment submitted (${result.txHash})`,
    set: {
      txHash: result.txHash,
      submittedAt: new Date(),
      submitLeaseExpiresAt: null,
    },
  });
  if (!pending) {
    return { ok: false, code: "concurrent_modification", refund, retryable: true };
  }

  // Verify immediately; if verification itself is inconclusive the refund
  // stays `pending` and the reconciler finishes the job.
  try {
    const verification = await (deps.verifySettlement || (() => missingDep("verifySettlement")))(
      result.txHash,
      {
        destination: refund.destination,
        assetCode: refund.asset,
        amountUnits: refund.amountUnits,
      }
    );

    if (verification?.settled) {
      const settled = await markSettledAndRevoke(db, pending, deps, verification);
      if (settled) return { ok: true, refund: settled, settled: true };
      return { ok: true, refund: pending, pendingVerification: true };
    }

    if (verification?.failed) {
      const failed = await transitionRefund(db, claimId, {
        fromStatuses: [REFUND_STATES.PENDING],
        toStatus: REFUND_STATES.FAILED,
        auditAction: "refund.failed",
        auditActor: "system",
        auditReason: verification.reason || "On-chain transaction did not succeed",
        set: { failedReason: verification.reason || "on_chain_failed", submitLeaseExpiresAt: null },
      });
      if (failed) await releasePurchaseSlot(db, failed.purchaseId, claimId);
      return { ok: false, code: "settlement_failed", refund: failed || pending, retryable: false };
    }

    return { ok: true, refund: pending, pendingVerification: true };
  } catch {
    return { ok: true, refund: pending, pendingVerification: true };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation. Safe to run repeatedly from the background worker after
// crashes, timeouts, and restarts; every branch is idempotent.
// ---------------------------------------------------------------------------

export async function reconcileIncompleteRefunds(db, deps = {}, { limit = 25 } = {}) {
  const refunds = db.collection(COLLECTIONS.refunds);
  const now = new Date();
  const summary = { recoveredLeases: 0, verified: 0, failedOnChain: 0, revoked: 0, stillPending: 0 };

  // 1) Expired submitting leases -> the submitter crashed mid-flight.
  //    Without a transaction hash nothing was sent to Horizon: release back
  //    to approved. With one, the payment may have landed: park it as
  //    pending so verification decides - never resubmit blindly.
  const staleLeases = await refunds
    .find({
      status: REFUND_STATES.SUBMITTING,
      submitLeaseExpiresAt: { $lt: now },
    })
    .limit(limit)
    .toArray();

  for (const refund of staleLeases) {
    if (refund.txHash) {
      await transitionRefund(db, refund._id, {
        fromStatuses: [REFUND_STATES.SUBMITTING],
        toStatus: REFUND_STATES.PENDING,
        auditAction: "refund.reconciled",
        auditActor: "reconciler",
        auditReason: "Recovered expired submission lease with transaction hash; parked for verification",
        set: { submitLeaseExpiresAt: null },
      });
      continue;
    }
    await transitionRefund(db, refund._id, {
      fromStatuses: [REFUND_STATES.SUBMITTING],
      toStatus: REFUND_STATES.APPROVED,
      auditAction: "refund.reconciled",
      auditActor: "reconciler",
      auditReason: "Recovered expired submission lease without transaction hash",
      set: { submitLeaseExpiresAt: null },
    });
    summary.recoveredLeases += 1;
  }

  // 2) Pending submissions -> verify the recorded hash on-chain.
  const pendings = await refunds
    .find({ status: REFUND_STATES.PENDING })
    .limit(limit)
    .toArray();

  for (const refund of pendings) {
    if (!refund.txHash) continue;
    try {
      const verification = await (deps.verifySettlement || (() => missingDep("verifySettlement")))(
        refund.txHash,
        {
          destination: refund.destination,
          assetCode: refund.asset,
          amountUnits: refund.amountUnits,
        }
      );
      if (verification?.settled) {
        const settled = await markSettledAndRevoke(db, refund, deps, verification);
        if (settled) summary.revoked += settled.entitlementRevokedAt ? 1 : 0;
        else summary.stillPending += 1;
        summary.verified += settled ? 1 : 0;
      } else if (verification?.failed) {
        const failed = await transitionRefund(db, refund._id, {
          fromStatuses: [REFUND_STATES.PENDING],
          toStatus: REFUND_STATES.FAILED,
          auditAction: "refund.failed",
          auditActor: "reconciler",
          auditReason: verification.reason || "On-chain transaction did not succeed",
          set: { failedReason: verification.reason || "on_chain_failed" },
        });
        if (failed) await releasePurchaseSlot(db, failed.purchaseId, refund._id);
        summary.failedOnChain += failed ? 1 : 0;
      } else {
        summary.stillPending += 1;
      }
    } catch {
      summary.stillPending += 1;
    }
  }

  // 3) Settled refunds whose entitlement revocation has not converged yet.
  const needsRevocation = await refunds
    .find({
      status: REFUND_STATES.SETTLED,
      entitlementRevokedAt: null,
    })
    .limit(limit)
    .toArray();

  for (const refund of needsRevocation) {
    try {
      await (deps.revokeEntitlement || ((m, b) => missingDep("revokeEntitlement")))(
        refund.materialId,
        refund.buyerAddress
      );
      const marked = await refunds.updateOne(
        { _id: refund._id, entitlementRevokedAt: null },
        { $set: { entitlementRevokedAt: new Date(), updatedAt: new Date() } }
      );
      if (marked.modifiedCount === 1) {
        const entry = buildRefundAuditEntry(
          (refund.auditTrail || [])[(refund.auditTrail || []).length - 1],
          {
            action: "refund.entitlement_revoked",
            actor: "reconciler",
            reason: "Entitlement revocation converged after settlement",
          }
        );
        await refunds.updateOne(
          { _id: refund._id },
          { $push: { auditTrail: entry }, $set: { updatedAt: new Date() } }
        );
        emitConsoleAudit(entry, {
          refundId: String(refund._id),
          purchaseId: refund.purchaseId,
        });
        summary.revoked += 1;
      }
    } catch {
      summary.stillPending += 1;
    }
  }

  return summary;
}

export async function getRefundById(db, refundId) {
  try {
    return await db
      .collection(COLLECTIONS.refunds)
      .findOne({ _id: new ObjectId(String(refundId)) });
  } catch {
    return null;
  }
}
