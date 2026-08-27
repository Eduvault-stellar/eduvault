import assert from "node:assert/strict";
import { test } from "node:test";

import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";
import {
  calculateEscrowBackoffMs,
  createEscrowOperation,
  executeEscrowCommand,
  processEscrowOperation,
  reconcileEscrowOperations,
} from "../../src/lib/escrow/escrowOperations.js";
import { createFakeDb } from "./helpers/fakeMongo.mjs";

const retryPolicy = Object.freeze({ maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 });

function command(idempotencyKey = "op-1") {
  return {
    idempotencyKey,
    operationType: "release",
    actor: "GACTOR",
    payload: { escrowId: "escrow-1", recipient: "GRECIPIENT", amount: "100" },
  };
}

test("idempotency key creates one operation and one submission attempt", async () => {
  const db = createFakeDb();
  let submissions = 0;
  const handlers = {
    async submit() {
      submissions += 1;
      return { transactionHash: "tx-1", ledgerSequence: 100 };
    },
    async confirm() {
      return { confirmed: false, reason: "not indexed yet" };
    },
    async project() {},
  };

  const first = await executeEscrowCommand(db, command(), handlers, {
    now: new Date("2026-01-01T00:00:00Z"),
    retryPolicy,
  });
  const second = await executeEscrowCommand(db, command(), handlers, {
    now: new Date("2026-01-01T00:00:00Z"),
    retryPolicy,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(submissions, 1);
  assert.equal(db.dump(COLLECTIONS.escrowOperations).length, 1);
  assert.equal(db.dump(COLLECTIONS.escrowOperations)[0].transactionHash, "tx-1");
});

test("same idempotency key with different payload is rejected", async () => {
  const db = createFakeDb();
  await createEscrowOperation(db, {
    ...command("same-key"),
    now: new Date("2026-01-01T00:00:00Z"),
  });

  await assert.rejects(
    () =>
      createEscrowOperation(db, {
        ...command("same-key"),
        payload: { escrowId: "other" },
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    /different escrow operation/,
  );
});

test("state machine reaches pending to submitted to confirmed", async () => {
  const db = createFakeDb();
  const result = await executeEscrowCommand(
    db,
    command("happy-path"),
    {
      async submit() {
        return { transactionHash: "tx-happy", ledgerSequence: 200 };
      },
      async confirm() {
        return { confirmed: true, transactionHash: "tx-happy", ledgerSequence: 201 };
      },
      async project(operation) {
        await db.collection(COLLECTIONS.payouts).updateOne(
          { payoutId: `${operation.payload.escrowId}-${operation.payload.recipient}` },
          {
            $set: {
              payoutId: `${operation.payload.escrowId}-${operation.payload.recipient}`,
              escrowId: operation.payload.escrowId,
              recipient: operation.payload.recipient,
              amount: operation.payload.amount,
              status: "claimed",
              chainTxHash: operation.transactionHash,
              createdAt: new Date("2026-01-01T00:00:00Z"),
              updatedAt: new Date("2026-01-01T00:00:00Z"),
            },
          },
          { upsert: true },
        );
      },
    },
    { now: new Date("2026-01-01T00:00:00Z"), retryPolicy },
  );

  assert.equal(result.operation.state, "confirmed");
  assert.equal(result.operation.stage, "done");
  assert.equal(result.operation.transactionHash, "tx-happy");
  assert.equal(db.dump(COLLECTIONS.payouts)[0].status, "claimed");
});

test("confirmation failure reaches terminal failed instead of retrying forever", async () => {
  const db = createFakeDb();
  await executeEscrowCommand(
    db,
    command("timeout-path"),
    {
      async submit() {
        return { transactionHash: "tx-timeout" };
      },
      async confirm() {
        return { confirmed: false, reason: "timeout" };
      },
      async project() {},
    },
    { now: new Date("2026-01-01T00:00:00Z"), retryPolicy },
  );

  for (const now of [
    new Date("2026-01-01T00:00:02Z"),
    new Date("2026-01-01T00:00:05Z"),
  ]) {
    await processEscrowOperation(db, "timeout-path", {
      confirm: async () => ({ confirmed: false, reason: "timeout" }),
      project: async () => {},
      now,
      retryPolicy,
    });
  }

  const operation = db.dump(COLLECTIONS.escrowOperations)[0];
  assert.equal(operation.state, "failed");
  assert.equal(operation.terminal, true);
  assert.equal(operation.retryCount, 3);
});

test("retry backoff is bounded exponential", () => {
  assert.equal(calculateEscrowBackoffMs(1, retryPolicy), 1_000);
  assert.equal(calculateEscrowBackoffMs(2, retryPolicy), 2_000);
  assert.equal(calculateEscrowBackoffMs(4, retryPolicy), 5_000);
});

test("timeout after submit is resolved by reconciliation from chain state", async () => {
  const db = createFakeDb();
  await executeEscrowCommand(
    db,
    command("reconcile-success"),
    {
      async submit() {
        return { transactionHash: "tx-reconcile" };
      },
      async confirm() {
        return { confirmed: false, reason: "client timed out" };
      },
      async project() {},
    },
    { now: new Date("2026-01-01T00:00:00Z"), retryPolicy },
  );

  const result = await reconcileEscrowOperations(db, {
    now: new Date("2026-01-01T00:00:02Z"),
    retryPolicy,
    queryChainState: async () => ({ found: true, confirmed: true, transactionHash: "tx-reconcile", ledgerSequence: 300 }),
    project: async (operation) => {
      await db.collection(COLLECTIONS.escrows).updateOne(
        { escrowId: operation.payload.escrowId },
        {
          $set: {
            escrowId: operation.payload.escrowId,
            status: "released",
            chainTxHash: operation.transactionHash,
            createdAt: new Date("2026-01-01T00:00:02Z"),
            updatedAt: new Date("2026-01-01T00:00:02Z"),
          },
        },
        { upsert: true },
      );
    },
  });

  assert.equal(result.reconciled.length, 1);
  assert.equal(db.dump(COLLECTIONS.escrowOperations)[0].state, "confirmed");
  assert.equal(db.dump(COLLECTIONS.escrows)[0].chainTxHash, "tx-reconcile");
});

test("confirmation never found reaches terminal failed through reconciliation", async () => {
  const db = createFakeDb();
  await executeEscrowCommand(
    db,
    command("reconcile-failure"),
    {
      async submit() {
        return { transactionHash: "tx-missing" };
      },
      async confirm() {
        return { confirmed: false, reason: "missing" };
      },
      async project() {},
    },
    { now: new Date("2026-01-01T00:00:00Z"), retryPolicy },
  );

  for (const now of [
    new Date("2026-01-01T00:00:02Z"),
    new Date("2026-01-01T00:00:05Z"),
  ]) {
    await reconcileEscrowOperations(db, {
      now,
      retryPolicy,
      queryChainState: async () => ({ found: false, reason: "not found" }),
      project: async () => {},
    });
  }

  const operation = db.dump(COLLECTIONS.escrowOperations)[0];
  assert.equal(operation.state, "failed");
  assert.equal(operation.terminal, true);
  assert.equal(operation.reconciliationFailureCount, 2);
});

test("crash recovery resumes after submission and completes without another submit", async () => {
  const db = createFakeDb();
  await createEscrowOperation(db, {
    ...command("crash-recovery"),
    now: new Date("2026-01-01T00:00:00Z"),
  });
  await db.collection(COLLECTIONS.escrowOperations).updateOne(
    { idempotencyKey: "crash-recovery" },
    {
      $set: {
        state: "submitted",
        stage: "confirmation",
        transactionHash: "tx-before-crash",
        nextAttemptAt: new Date("2026-01-01T00:00:00Z"),
      },
    },
  );

  let submissions = 0;
  const result = await processEscrowOperation(db, "crash-recovery", {
    submit: async () => {
      submissions += 1;
      return { transactionHash: "should-not-submit" };
    },
    confirm: async () => ({ confirmed: true, transactionHash: "tx-before-crash", ledgerSequence: 400 }),
    project: async () => {},
    now: new Date("2026-01-01T00:00:01Z"),
    retryPolicy,
  });

  assert.equal(submissions, 0);
  assert.equal(result.operation.state, "confirmed");
  assert.equal(result.operation.transactionHash, "tx-before-crash");
});
