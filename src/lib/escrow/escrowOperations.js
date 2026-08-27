import { createHash } from "node:crypto";

import { COLLECTIONS } from "../backend/schemaContracts.js";
import { incrementCounter, setGauge } from "../telemetry/metrics.js";

export const ESCROW_OPERATION_STATE = Object.freeze({
  PENDING: "pending",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  RECONCILING: "reconciling",
});

export const ESCROW_OPERATION_STAGE = Object.freeze({
  SUBMISSION: "submission",
  CONFIRMATION: "confirmation",
  PROJECTION: "projection",
  DONE: "done",
});

export const DEFAULT_ESCROW_OPERATION_RETRY_POLICY = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
});

function duplicateKey(error) {
  return error?.code === 11000;
}

function ordered(value) {
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(ordered);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

export function hashEscrowPayload(payload) {
  return createHash("sha256").update(JSON.stringify(ordered(payload ?? {}))).digest("hex");
}

export function calculateEscrowBackoffMs(
  retryCount,
  {
    baseDelayMs = DEFAULT_ESCROW_OPERATION_RETRY_POLICY.baseDelayMs,
    maxDelayMs = DEFAULT_ESCROW_OPERATION_RETRY_POLICY.maxDelayMs,
  } = {},
) {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, retryCount - 1));
}

async function insertAudit(db, { operationId, action, actor, before = null, after = null, now = new Date() }) {
  await db.collection(COLLECTIONS.escrowOperationAudit).insertOne({
    _id: `${operationId}:${action}:${now.getTime()}:${Math.random().toString(16).slice(2)}`,
    operationId,
    action,
    actor: actor ?? null,
    before,
    after,
    createdAt: now,
  });
}

function summarizeForMetrics(operation, now) {
  const ageMs = operation?.createdAt instanceof Date ? now.getTime() - operation.createdAt.getTime() : 0;
  setGauge("escrow_operation_age_ms", { state: operation?.state || "unknown" }, Math.max(0, ageMs));
  setGauge("escrow_operation_retry_count", { state: operation?.state || "unknown" }, operation?.retryCount || 0);
  setGauge(
    "escrow_operation_reconciliation_failure_count",
    { state: operation?.state || "unknown" },
    operation?.reconciliationFailureCount || 0,
  );
}

export async function createEscrowOperation(
  db,
  { idempotencyKey, operationType, payload, actor = null, now = new Date() },
) {
  if (!idempotencyKey) throw new Error("idempotencyKey is required");
  if (!operationType) throw new Error("operationType is required");

  const payloadHash = hashEscrowPayload(payload);
  const operation = {
    _id: idempotencyKey,
    idempotencyKey,
    operationType,
    payloadHash,
    payload,
    actor,
    state: ESCROW_OPERATION_STATE.PENDING,
    stage: ESCROW_OPERATION_STAGE.SUBMISSION,
    transactionHash: null,
    ledgerSequence: null,
    retryCount: 0,
    reconciliationFailureCount: 0,
    terminal: false,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.collection(COLLECTIONS.escrowOperations).insertOne(operation);
    await insertAudit(db, {
      operationId: idempotencyKey,
      action: "created",
      actor,
      after: operation,
      now,
    });
    incrementCounter("escrow_operations_created_total", { operationType });
    summarizeForMetrics(operation, now);
    return { operation, created: true };
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }

  const existing = await db.collection(COLLECTIONS.escrowOperations).findOne({ idempotencyKey });
  if (!existing) throw new Error("idempotency key exists but operation record could not be loaded");
  if (existing.operationType !== operationType || existing.payloadHash !== payloadHash) {
    throw new Error("idempotency key was already used for a different escrow operation");
  }
  summarizeForMetrics(existing, now);
  return { operation: existing, created: false };
}

async function loadOperation(db, idempotencyKey) {
  const operation = await db.collection(COLLECTIONS.escrowOperations).findOne({ idempotencyKey });
  if (!operation) throw new Error(`escrow operation not found: ${idempotencyKey}`);
  return operation;
}

async function markFailure(db, operation, { stage, error, actor, retryPolicy, now, reconciliation = false }) {
  const retryCount = (operation.retryCount || 0) + 1;
  const terminal = retryCount >= retryPolicy.maxRetries;
  const state = terminal ? ESCROW_OPERATION_STATE.FAILED : operation.state;
  const backoffMs = calculateEscrowBackoffMs(retryCount, retryPolicy);
  const nextAttemptAt = terminal ? null : new Date(now.getTime() + backoffMs);
  const before = { ...operation };
  const patch = {
    state,
    stage,
    retryCount,
    terminal,
    nextAttemptAt,
    lastError: String(error?.message || error),
    updatedAt: now,
  };
  if (reconciliation) {
    patch.reconciliationFailureCount = (operation.reconciliationFailureCount || 0) + 1;
  }

  await db.collection(COLLECTIONS.escrowOperations).updateOne(
    { idempotencyKey: operation.idempotencyKey },
    { $set: patch },
  );
  const after = { ...operation, ...patch };
  await insertAudit(db, {
    operationId: operation.idempotencyKey,
    action: terminal ? "failed_terminal" : "retry_scheduled",
    actor,
    before,
    after,
    now,
  });
  incrementCounter("escrow_operation_stage_failures_total", {
    stage,
    terminal: String(terminal),
  });
  summarizeForMetrics(after, now);
  return after;
}

async function persistTransition(db, operation, patch, { action, actor, now }) {
  const before = { ...operation };
  const after = { ...operation, ...patch, updatedAt: now };
  await db.collection(COLLECTIONS.escrowOperations).updateOne(
    { idempotencyKey: operation.idempotencyKey },
    { $set: { ...patch, updatedAt: now } },
  );
  await insertAudit(db, {
    operationId: operation.idempotencyKey,
    action,
    actor,
    before,
    after,
    now,
  });
  summarizeForMetrics(after, now);
  return after;
}

export async function processEscrowOperation(
  db,
  idempotencyKey,
  {
    submit,
    confirm,
    project,
    actor = "system",
    now = new Date(),
    retryPolicy = DEFAULT_ESCROW_OPERATION_RETRY_POLICY,
  } = {},
) {
  let operation = await loadOperation(db, idempotencyKey);
  if (operation.terminal || operation.stage === ESCROW_OPERATION_STAGE.DONE) {
    summarizeForMetrics(operation, now);
    return { operation, attemptedSubmission: false };
  }
  if (operation.nextAttemptAt && operation.nextAttemptAt > now) {
    summarizeForMetrics(operation, now);
    return { operation, deferred: true, attemptedSubmission: false };
  }

  let attemptedSubmission = false;

  if (operation.stage === ESCROW_OPERATION_STAGE.SUBMISSION || operation.state === ESCROW_OPERATION_STATE.PENDING) {
    if (typeof submit !== "function") throw new Error("submit handler is required");
    try {
      attemptedSubmission = true;
      const submitted = await submit(operation);
      operation = await persistTransition(
        db,
        operation,
        {
          state: ESCROW_OPERATION_STATE.SUBMITTED,
          stage: ESCROW_OPERATION_STAGE.CONFIRMATION,
          transactionHash: submitted?.transactionHash || submitted?.txHash || operation.transactionHash || null,
          ledgerSequence: submitted?.ledgerSequence ?? submitted?.ledger ?? operation.ledgerSequence ?? null,
          submittedAt: now,
          nextAttemptAt: now,
          lastError: null,
        },
        { action: "submitted", actor, now },
      );
    } catch (error) {
      return {
        operation: await markFailure(db, operation, {
          stage: ESCROW_OPERATION_STAGE.SUBMISSION,
          error,
          actor,
          retryPolicy,
          now,
        }),
        attemptedSubmission,
      };
    }
  }

  if (operation.stage === ESCROW_OPERATION_STAGE.CONFIRMATION || operation.state === ESCROW_OPERATION_STATE.SUBMITTED) {
    if (typeof confirm !== "function") throw new Error("confirm handler is required");
    try {
      const confirmation = await confirm(operation);
      if (confirmation?.confirmed === false) {
        throw new Error(confirmation.reason || "escrow operation has not confirmed");
      }
      operation = await persistTransition(
        db,
        operation,
        {
          state: ESCROW_OPERATION_STATE.CONFIRMED,
          stage: ESCROW_OPERATION_STAGE.PROJECTION,
          transactionHash: confirmation?.transactionHash || confirmation?.txHash || operation.transactionHash || null,
          ledgerSequence: confirmation?.ledgerSequence ?? confirmation?.ledger ?? operation.ledgerSequence ?? null,
          onChainState: confirmation?.onChainState || confirmation || null,
          confirmedAt: now,
          nextAttemptAt: now,
          lastError: null,
        },
        { action: "confirmed", actor, now },
      );
    } catch (error) {
      return {
        operation: await markFailure(db, operation, {
          stage: ESCROW_OPERATION_STAGE.CONFIRMATION,
          error,
          actor,
          retryPolicy,
          now,
        }),
        attemptedSubmission,
      };
    }
  }

  if (operation.stage === ESCROW_OPERATION_STAGE.PROJECTION || operation.state === ESCROW_OPERATION_STATE.CONFIRMED) {
    if (typeof project !== "function") throw new Error("project handler is required");
    try {
      await project(operation);
      operation = await persistTransition(
        db,
        operation,
        {
          state: ESCROW_OPERATION_STATE.CONFIRMED,
          stage: ESCROW_OPERATION_STAGE.DONE,
          projectedAt: now,
          terminal: false,
          nextAttemptAt: null,
          lastError: null,
        },
        { action: "projected", actor, now },
      );
      incrementCounter("escrow_operations_completed_total", { operationType: operation.operationType });
    } catch (error) {
      return {
        operation: await markFailure(db, operation, {
          stage: ESCROW_OPERATION_STAGE.PROJECTION,
          error,
          actor,
          retryPolicy,
          now,
        }),
        attemptedSubmission,
      };
    }
  }

  return { operation, attemptedSubmission };
}

export async function executeEscrowCommand(
  db,
  command,
  handlers,
  options = {},
) {
  const { operation, created } = await createEscrowOperation(db, {
    idempotencyKey: command.idempotencyKey,
    operationType: command.operationType,
    payload: command.payload,
    actor: command.actor ?? null,
    now: options.now || new Date(),
  });

  const result = await processEscrowOperation(db, operation.idempotencyKey, {
    ...handlers,
    actor: command.actor ?? options.actor ?? "system",
    now: options.now || new Date(),
    retryPolicy: options.retryPolicy || DEFAULT_ESCROW_OPERATION_RETRY_POLICY,
  });

  return { ...result, created };
}

async function collectDueOperations(db, { now, limit }) {
  const filter = {
    state: {
      $in: [
        ESCROW_OPERATION_STATE.PENDING,
        ESCROW_OPERATION_STATE.SUBMITTED,
        ESCROW_OPERATION_STATE.RECONCILING,
      ],
    },
    terminal: { $ne: true },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }, { nextAttemptAt: { $exists: false } }],
  };
  const cursor = db.collection(COLLECTIONS.escrowOperations).find(filter).limit(limit);
  const operations = [];
  for await (const operation of cursor) operations.push(operation);
  return operations;
}

export async function reconcileEscrowOperations(
  db,
  {
    queryChainState,
    project,
    actor = "system",
    now = new Date(),
    limit = 100,
    retryPolicy = DEFAULT_ESCROW_OPERATION_RETRY_POLICY,
  } = {},
) {
  if (typeof queryChainState !== "function") throw new Error("queryChainState handler is required");

  const operations = await collectDueOperations(db, { now, limit });
  const reconciled = [];
  const failed = [];

  for (const candidate of operations) {
    let operation = await persistTransition(
      db,
      candidate,
      { state: ESCROW_OPERATION_STATE.RECONCILING, previousState: candidate.state, nextAttemptAt: now },
      { action: "reconcile_started", actor, now },
    );

    try {
      const chain = await queryChainState(operation);
      if (!chain || chain.found === false || chain.confirmed === false) {
        throw new Error(chain?.reason || "escrow operation not found confirmed on-chain");
      }

      operation = await persistTransition(
        db,
        operation,
        {
          state: ESCROW_OPERATION_STATE.CONFIRMED,
          stage: ESCROW_OPERATION_STAGE.PROJECTION,
          transactionHash: chain.transactionHash || chain.txHash || operation.transactionHash || null,
          ledgerSequence: chain.ledgerSequence ?? chain.ledger ?? operation.ledgerSequence ?? null,
          onChainState: chain,
          confirmedAt: operation.confirmedAt || now,
          nextAttemptAt: now,
          lastError: null,
        },
        { action: "reconciled_from_chain", actor, now },
      );

      const projected = await processEscrowOperation(db, operation.idempotencyKey, {
        submit: async () => {
          throw new Error("submission is not allowed during projection-only reconciliation");
        },
        confirm: async () => chain,
        project,
        actor,
        now,
        retryPolicy,
      });
      reconciled.push({ idempotencyKey: operation.idempotencyKey, state: projected.operation.state });
    } catch (error) {
      const next = await markFailure(db, operation, {
        stage: operation.stage || ESCROW_OPERATION_STAGE.CONFIRMATION,
        error,
        actor,
        retryPolicy,
        now,
        reconciliation: true,
      });
      failed.push({ idempotencyKey: next.idempotencyKey, state: next.state, error: next.lastError });
    }
  }

  incrementCounter("escrow_operation_reconcile_runs_total", { outcome: "completed" });
  return { scanned: operations.length, reconciled, failed };
}
