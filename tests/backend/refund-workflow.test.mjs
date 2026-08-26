import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach } from "node:test";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import * as dotenv from "dotenv";

// For tests, load .env.local if present, else .env
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import {
  REFUND_POLICY_VERSION,
  approveRefundClaim,
  createRefundClaim,
  getRefundById,
  reconcileIncompleteRefunds,
  settleApprovedRefund,
} from "../../src/lib/refunds/refundWorkflow.js";
import { REFUND_STATES } from "../../src/lib/refunds/stateMachine.js";

const TEST_DB = "eduvault_test_refunds";
const BUYER = "gbuyer1111111111111111111111111111111111111111111111111111111111";

let mongoServer;
let client;
let db;
let dbAvailable = false;

const ENV_SNAPSHOT = {};
function setEnv(name, value) {
  if (!(name in ENV_SNAPSHOT)) ENV_SNAPSHOT[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let submitCounter = 0;
function baseDeps(overrides = {}) {
  return {
    preflight: overrides.preflight || (() => {}),
    submitPayment:
      overrides.submitPayment ||
      (async () => ({
        txHash: `FAKEHASH${(++submitCounter).toString(16).padStart(8, "0")}`,
      })),
    verifySettlement:
      overrides.verifySettlement ||
      (async () => ({ settled: true, ledger: 424242, operationIndex: 1 })),
    revokeEntitlement: overrides.revokeEntitlement || (async () => ({ success: true })),
    ...overrides,
  };
}

async function insertPurchase(overrides = {}) {
  const purchase = {
    materialId: "material-refund-test",
    buyerAddress: BUYER,
    userEmail: null,
    status: "confirmed",
    transactionHash: `TXTXTX${overrides.transactionHash ?? Math.random().toString(16).slice(2, 10)}`,
    amount: "5000000",
    asset: "XLM",
    confirmedAt: new Date(),
    purchasedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  const result = await db.collection("purchases").insertOne(purchase);
  return { ...purchase, _id: result.insertedId };
}

describe("Refund workflow (#27)", () => {
  before(async () => {
    try {
      mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      const uri = mongoServer.getUri();
      process.env.MONGODB_URI = uri;
      process.env.MONGODB_DB = TEST_DB;

      client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      db = client.db(TEST_DB);
      dbAvailable = true;
    } catch (err) {
      console.warn("[WARN] Skipping refund-workflow tests: MongoDB not available. Details: " + err.message);
      dbAvailable = false;
    }
  });

  after(async () => {
    for (const [name, value] of Object.entries(ENV_SNAPSHOT)) {
      setEnv(name, value);
    }
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Restore any policy env vars mutated by a previous test so tests stay
    // order-independent.
    for (const [name, value] of Object.entries(ENV_SNAPSHOT)) {
      setEnv(name, value);
    }
    await db.collection("refunds").deleteMany({});
    await db.collection("purchases").deleteMany({});
    await db.collection("entitlement_cache").deleteMany({});
  });

  test("claim creation derives every parameter from trusted records", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});

    const result = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
      reason: "course withdrawn",
      network: "Test SDF Network ; September 2015",
    });
    assert.equal(result.ok, true);

    const refund = result.refund;
    assert.equal(refund.status, REFUND_STATES.REQUESTED);
    assert.equal(refund.amountUnits, "5000000");
    assert.equal(refund.destination, BUYER.toLowerCase());
    assert.equal(refund.asset, "XLM");
    assert.equal(refund.materialId, purchase.materialId);
    assert.equal(refund.network, "Test SDF Network ; September 2015");
    assert.equal(refund.policyVersion, REFUND_POLICY_VERSION);

    // Tamper-evident audit trail starts from a genesis-chained entry.
    assert.equal(refund.auditTrail.length, 1);
    assert.equal(refund.auditTrail[0].prevHash, "0".repeat(64));
    assert.match(refund.auditTrail[0].hash, /^[a-f0-9]{64}$/);
    assert.ok(refund.auditTrail[0].correlationId !== undefined);
  });

  test("partial claims are clamped server-side with fee allocation", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    setEnv("REFUND_FEE_BPS", "1000"); // platform retains 10%

    const result = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      requestedAmount: "2000000",
      actor: "buyer-admin",
    });
    assert.equal(result.ok, true);
    assert.equal(result.refund.claimedUnits, "2000000");
    assert.equal(result.refund.amountUnits, "1800000");
    assert.equal(result.refund.feeRetainedUnits, "200000");
  });

  test("claims against unknown or unfinalized purchases are refused", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");

    const missing = await createRefundClaim(db, {
      transactionId: "DOESNOTEXIST",
      actor: "buyer-admin",
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "purchase_not_found");

    await insertPurchase({ transactionHash: "PENDINGTX", status: "pending" });
    const pending = await createRefundClaim(db, {
      transactionId: "PENDINGTX",
      actor: "buyer-admin",
    });
    assert.equal(pending.ok, false);
    assert.equal(pending.code, "purchase_not_found");
  });

  test("claims outside the refund window are refused", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({
      confirmedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      purchasedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const result = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "refund_window_expired");
  });

  test("duplicate active claims for one purchase are rejected", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});

    const first = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    assert.equal(first.ok, true);

    const second = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, "duplicate_active_claim");
  });

  test("concurrent approvals allow exactly one winner and bind the slot", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});

    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    assert.equal(claim.ok, true);

    const [a, b] = await Promise.all([
      approveRefundClaim(db, { refundId: String(claim.refund._id), actor: "admin-a" }),
      approveRefundClaim(db, { refundId: String(claim.refund._id), actor: "admin-b" }),
    ]);

    const winners = [a, b].filter((r) => r.ok && !r.alreadyApproved);
    assert.equal(winners.length, 1);

    const refund = await getRefundById(db, String(claim.refund._id));
    assert.equal(refund.status, REFUND_STATES.APPROVED);

    const freshPurchase = await db.collection("purchases").findOne({ _id: purchase._id });
    assert.equal(String(freshPurchase.activeRefundId), String(claim.refund._id));

    const approvals = refund.auditTrail.filter((e) => e.action === "refund.approved");
    assert.equal(approvals.length, 1);
  });

  test("settlement verifies on-chain payment, records ledger, and revokes access", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    await approveRefundClaim(db, { refundId: String(claim.refund._id), actor: "admin-a" });

    await db.collection("entitlement_cache").insertOne({
      materialId: purchase.materialId,
      buyerAddress: BUYER.toLowerCase(),
      active: true,
      source: "chain",
    });

    let revokedWith = null;
    const deps = baseDeps({
      revokeEntitlement: async (materialId, buyerAddress) => {
        revokedWith = { materialId, buyerAddress };
        return { success: true };
      },
    });

    const settlement = await settleApprovedRefund(
      db,
      String(claim.refund._id),
      deps
    );
    assert.equal(settlement.ok, true);
    assert.equal(settlement.settled, true);

    const refund = await getRefundById(db, String(claim.refund._id));
    assert.equal(refund.status, REFUND_STATES.SETTLED);
    assert.match(refund.txHash, /^FAKEHASH/);
    assert.equal(refund.ledger, 424242);
    assert.equal(refund.operationIndex, 1);
    assert.ok(refund.entitlementRevokedAt);
    assert.deepEqual(revokedWith, {
      materialId: purchase.materialId,
      buyerAddress: BUYER.toLowerCase(),
    });

    // Slot released so partial follow-up claims remain possible.
    const freshPurchase = await db.collection("purchases").findOne({ _id: purchase._id });
    assert.equal(freshPurchase.activeRefundId, null);

    // Audit chain links every entry to its predecessor.
    const trail = refund.auditTrail;
    for (let i = 1; i < trail.length; i++) {
      assert.equal(trail[i].prevHash, trail[i - 1].hash);
    }
  });

  test("Horizon timeout after acceptance parks the refund for reconciliation", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    await approveRefundClaim(db, { refundId: String(claim.refund._id), actor: "admin-a" });

    const ambiguousError = Object.assign(new Error("Request timed out"), {
      classification: "timeout_unknown",
      txHash: "AMBIGUOUS_HASH_1",
    });
    const firstAttempt = await settleApprovedRefund(
      db,
      String(claim.refund._id),
      baseDeps({ submitPayment: async () => { throw ambiguousError; } })
    );
    assert.equal(firstAttempt.ok, true);
    assert.equal(firstAttempt.pendingVerification, true);

    let refund = await getRefundById(db, String(claim.refund._id));
    assert.equal(refund.status, REFUND_STATES.PENDING);
    assert.equal(refund.txHash, "AMBIGUOUS_HASH_1");

    // Reconciliation proves the payment landed and converges the workflow.
    const summary = await reconcileIncompleteRefunds(db, baseDeps(), {});
    assert.equal(summary.verified, 1);

    refund = await getRefundById(db, String(claim.refund._id));
    assert.equal(refund.status, REFUND_STATES.SETTLED);
    assert.ok(refund.entitlementRevokedAt);
  });

  test("on-chain failure never revokes access and releases the slot", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    await approveRefundClaim(db, { refundId: String(claim.refund._id), actor: "admin-a" });

    await db.collection("entitlement_cache").insertOne({
      materialId: purchase.materialId,
      buyerAddress: BUYER.toLowerCase(),
      active: true,
      source: "chain",
    });

    let revokeCalls = 0;
    const settlement = await settleApprovedRefund(
      db,
      String(claim.refund._id),
      baseDeps({
        verifySettlement: async () => ({
          settled: false,
          failed: true,
          reason: "on_chain_transaction_failed",
        }),
        revokeEntitlement: async () => {
          revokeCalls += 1;
          return { success: true };
        },
      })
    );
    assert.equal(settlement.ok, false);
    assert.equal(settlement.retryable, false);

    const refund = await getRefundById(db, String(claim.refund._id));
    assert.equal(refund.status, REFUND_STATES.FAILED);
    assert.equal(refund.failedReason, "on_chain_transaction_failed");
    assert.equal(revokeCalls, 0);
    assert.equal(refund.entitlementRevokedAt, null);

    const cached = await db.collection("entitlement_cache").findOne({
      buyerAddress: BUYER.toLowerCase(),
    });
    assert.equal(cached.active, true);

    const freshPurchase = await db.collection("purchases").findOne({ _id: purchase._id });
    assert.equal(freshPurchase.activeRefundId, null);
  });

  test("destination/asset mismatch is treated as a settlement failure", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    await approveRefundClaim(db, { refundId: String(claim.refund._id), actor: "admin-a" });

    const settlement = await settleApprovedRefund(
      db,
      String(claim.refund._id),
      baseDeps({
        verifySettlement: async () => ({
          settled: false,
          failed: true,
          reason: "settlement_mismatch",
        }),
      })
    );
    assert.equal(settlement.ok, false);

    const refund = await getRefundById(db, String(claim.refund._id));
    assert.equal(refund.status, REFUND_STATES.FAILED);
    assert.equal(refund.failedReason, "settlement_mismatch");
  });

  test("transient submission failures roll back to approved for retry", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    const refundId = String(claim.refund._id);
    await approveRefundClaim(db, { refundId, actor: "admin-a" });

    const retryable = await settleApprovedRefund(
      db,
      refundId,
      baseDeps({
        submitPayment: async () => { throw new Error("Bad sequence: txx"); },
      })
    );
    assert.equal(retryable.ok, false);
    assert.equal(retryable.retryable, true);

    let refund = await getRefundById(db, refundId);
    assert.equal(refund.status, REFUND_STATES.APPROVED);
    assert.equal(refund.attempts, 1);

    // A subsequent attempt with a healthy signer settles normally.
    const retried = await settleApprovedRefund(db, refundId, baseDeps());
    assert.equal(retried.ok, true);
    assert.equal(retried.settled, true);

    refund = await getRefundById(db, refundId);
    assert.equal(refund.status, REFUND_STATES.SETTLED);
  });

  test("exhausted submission attempts terminate the claim as failed", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    setEnv("REFUND_MAX_SUBMIT_ATTEMPTS", "1");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    const refundId = String(claim.refund._id);
    await approveRefundClaim(db, { refundId, actor: "admin-a" });

    const result = await settleApprovedRefund(
      db,
      refundId,
      baseDeps({
        submitPayment: async () => { throw new Error("connection reset"); },
      })
    );
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);

    const refund = await getRefundById(db, refundId);
    assert.equal(refund.status, REFUND_STATES.FAILED);
    assert.match(refund.failedReason, /attempts exhausted/i);
  });

  test("crashed submitters are recovered from expired leases by reconciliation", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    const refundId = String(claim.refund._id);
    await approveRefundClaim(db, { refundId, actor: "admin-a" });

    // Simulate a crash mid-submission before Horizon saw anything: stuck in
    // submitting with an expired lease and no hash.
    await db.collection("refunds").updateOne(
      { _id: claim.refund._id },
      {
        $set: {
          status: REFUND_STATES.SUBMITTING,
          submitLeaseExpiresAt: new Date(Date.now() - 1000),
        },
      }
    );

    const summary = await reconcileIncompleteRefunds(db, baseDeps(), {});
    assert.equal(summary.recoveredLeases, 1);

    const refund = await getRefundById(db, refundId);
    assert.equal(refund.status, REFUND_STATES.APPROVED);

    // A crash after the payment was accepted but before parking as pending is
    // recovered by verification instead of resubmission.
    const second = await insertPurchase({ transactionHash: "CRASHAFTERSUBMIT", amount: "1000000" });
    const claim2 = await createRefundClaim(db, {
      transactionId: second.transactionHash,
      actor: "buyer-admin",
    });
    const refundId2 = String(claim2.refund._id);
    await approveRefundClaim(db, { refundId: refundId2, actor: "admin-a" });
    await db.collection("refunds").updateOne(
      { _id: claim2.refund._id },
      {
        $set: {
          status: REFUND_STATES.SUBMITTING,
          submitLeaseExpiresAt: new Date(Date.now() - 1000),
          txHash: "CRASHED_BUT_ACCEPTED",
        },
      }
    );

    await reconcileIncompleteRefunds(db, baseDeps(), {});

    const refund2 = await getRefundById(db, refundId2);
    assert.equal(refund2.status, REFUND_STATES.SETTLED);
    assert.equal(refund2.txHash, "CRASHED_BUT_ACCEPTED");
  });

  test("revocation converges after a crash between settlement and revoke", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    const refundId = String(claim.refund._id);
    await approveRefundClaim(db, { refundId, actor: "admin-a" });

    let revokeCalls = 0;
    await settleApprovedRefund(
      db,
      refundId,
      baseDeps({
        revokeEntitlement: async () => {
          revokeCalls += 1;
          throw new Error("mongo unavailable");
        },
      })
    );

    let refund = await getRefundById(db, refundId);
    assert.equal(revokeCalls, 1); // attempted during settlement...
    assert.equal(refund.status, REFUND_STATES.SETTLED); // ...but funds stay settled
    assert.equal(refund.entitlementRevokedAt, null);

    // Restart-safe reconciliation finishes the job without touching funds again.
    const summary = await reconcileIncompleteRefunds(db, baseDeps(), {});
    assert.equal(summary.revoked, 1);

    refund = await getRefundById(db, refundId);
    assert.ok(refund.entitlementRevokedAt);
  });

  test("daily treasury cap blocks new claims once exhausted", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    setEnv("REFUND_DAILY_CAP_UNITS", "6000000");

    const drained = await insertPurchase({ transactionHash: "DRAINED1", amount: "5000000" });
    const first = await createRefundClaim(db, {
      transactionId: drained.transactionHash,
      actor: "buyer-admin",
    });
    await approveRefundClaim(db, {
      refundId: String(first.refund._id),
      actor: "admin-a",
    });
    await settleApprovedRefund(db, String(first.refund._id), baseDeps());

    const next = await insertPurchase({ transactionHash: "NEXTONE", amount: "4000000" });
    const second = await createRefundClaim(db, {
      transactionId: next.transactionHash,
      actor: "buyer-admin",
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, "daily_cap_exceeded");
  });

  test("sequential partial refunds work after each settlement", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({}); // paid 5_000_000

    async function claimApproveSettle(amountUnits) {
      const claim = await createRefundClaim(db, {
        transactionId: purchase.transactionHash,
        requestedAmount: amountUnits,
        actor: "buyer-admin",
      });
      assert.equal(claim.ok, true, `claim for ${amountUnits}: ${claim.message}`);
      const approval = await approveRefundClaim(db, {
        refundId: String(claim.refund._id),
        actor: "admin-a",
      });
      assert.equal(approval.ok, true, `approval for ${amountUnits}`);
      const settlement = await settleApprovedRefund(
        db,
        String(claim.refund._id),
        baseDeps()
      );
      assert.equal(settlement.ok, true, `settlement for ${amountUnits}`);
      return claim;
    }

    await claimApproveSettle("3000000");

    // Second partial claim within the remainder is allowed.
    const second = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      requestedAmount: "2500000",
      actor: "buyer-admin",
    });
    assert.equal(second.ok, true);
    assert.equal(second.refund.amountUnits, "2000000"); // clamped to remainder

    await approveRefundClaim(db, {
      refundId: String(second.refund._id),
      actor: "admin-a",
    });
    await settleApprovedRefund(db, String(second.refund._id), baseDeps());

    // Fully refunded now.
    const third = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    assert.equal(third.ok, false);
    assert.equal(third.code, "already_refunded");
  });

  test("approving a settled claim can never pay twice", async (t) => {
    if (!dbAvailable) return t.skip("MongoDB not available");
    const purchase = await insertPurchase({});
    const claim = await createRefundClaim(db, {
      transactionId: purchase.transactionHash,
      actor: "buyer-admin",
    });
    const refundId = String(claim.refund._id);
    await approveRefundClaim(db, { refundId, actor: "admin-a" });
    const first = await settleApprovedRefund(db, refundId, baseDeps());
    assert.equal(first.settled, true);

    const again = await settleApprovedRefund(db, refundId, baseDeps());
    assert.equal(again.ok, true);
    assert.equal(again.alreadySettled, true);
    assert.equal(again.settled, undefined);
  });
});
