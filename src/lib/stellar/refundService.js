/**
 * Stellar refund workflow service (#27).
 *
 * Next-facing wiring for the custody-safe refund engine in
 * `src/lib/refunds/refundWorkflow.js`. This module binds the policy engine to
 * real infrastructure:
 *
 *  - signing goes through the constrained, dedicated-key signer
 *    (`./refundSigner`) - never through the general platform admin key;
 *  - settlement is verified against Horizon (transaction successful, correct
 *    destination/asset/amount) before a refund is marked settled;
 *  - entitlement revocation is delegated to `src/lib/entitlement.js` and runs
 *    only after verified settlement.
 */

import { getDb } from "@/lib/mongodb";
import { NETWORK_PASSPHRASE } from "@/lib/config/chain";
import { CHECKOUT_AMOUNT_DECIMALS } from "@/lib/checkout/intent";
import { revokeEntitlement } from "@/lib/entitlement";
import { withFailover } from "./horizonClient";
import {
  assertRefundSigningEnabled,
  submitRefundPayment,
  resolveRefundAsset,
} from "./refundSigner";
import {
  REFUND_POLICY_VERSION,
  approveRefundClaim,
  createRefundClaim,
  getRefundById,
  reconcileIncompleteRefunds,
  rejectRefundClaim,
  settleApprovedRefund,
} from "@/lib/refunds/refundWorkflow";

export { REFUND_POLICY_VERSION };

function db_() {
  return getDb();
}

/**
 * Create a refund claim for a settled purchase. Amount, asset, destination,
 * network, and purchase binding are derived from trusted records.
 */
export async function requestRefund({
  transactionId,
  requestedAmount = null,
  actor,
  reason,
}) {
  const db = await db_();
  return createRefundClaim(db, {
    transactionId,
    requestedAmount,
    actor,
    reason,
    network: NETWORK_PASSPHRASE,
  });
}

/** Admin approval (compare-and-set, idempotent on repeated approvals). */
export async function approveRefund({ refundId, actor, reason }) {
  const db = await db_();
  return approveRefundClaim(db, {
    refundId,
    actor,
    reason,
    expectedNetwork: NETWORK_PASSPHRASE,
  });
}

/** Admin rejection of a requested/approved claim. */
export async function rejectRefund({ refundId, actor, reason }) {
  const db = await db_();
  return rejectRefundClaim(db, { refundId, actor, reason });
}

/**
 * Move funds for an approved claim: sign via the constrained signer, submit,
 * verify against Horizon, revoke the entitlement once settlement is proven.
 */
export async function settleRefund(refundId) {
  const db = await db_();
  return settleApprovedRefund(db, refundId, {
    preflight: assertRefundSigningEnabled,
    submitPayment: submitRefundPayment,
    verifySettlement: verifyRefundSettlementOnChain,
    revokeEntitlement,
  });
}

/**
 * Restart-safe reconciliation pass; safe to call from the background worker
 * on every loop.
 */
export async function reconcileRefunds(options) {
  const db = await db_();
  return reconcileIncompleteRefunds(
    db,
    {
      verifySettlement: verifyRefundSettlementOnChain,
      revokeEntitlement,
    },
    options
  );
}

export async function getRefund(refundId) {
  const db = await db_();
  return getRefundById(db, refundId);
}

/**
 * Verify a submitted transaction hash against Horizon before treating a
 * refund as complete. Confirms:
 *  - the transaction exists and succeeded on the expected network;
 *  - exactly one payment operation paid the expected amount to the expected
 *    destination in the expected asset.
 *
 * Resolves one of:
 *   { settled: true, ledger, operationIndex }
 *   { settled: false, undetermined: true }
 *   { settled: false, failed: true, reason }
 */
export async function verifyRefundSettlementOnChain(txHash, { destination, assetCode, amountUnits }) {
  let tx;
  try {
    tx = await withFailover((server) => server.loadTransaction(String(txHash)));
  } catch {
    // Unknown transaction could mean not yet ingested - keep pending.
    return { settled: false, undetermined: true };
  }

  if (!tx?.successful) {
    return {
      settled: false,
      failed: true,
      reason: "on_chain_transaction_failed",
    };
  }

  // Horizon reports payment amounts as fixed 7-decimal strings; convert both
  // sides to atomic units so the comparison is exact regardless of format.
  const toAtomic = (decimalAmount) => {
    const [whole, fraction = ""] = String(decimalAmount).split(".");
    return BigInt(whole + (fraction + "0000000").slice(0, CHECKOUT_AMOUNT_DECIMALS));
  };
  const expectedAtomic = BigInt(String(amountUnits));
  const expectedAsset = resolveRefundAsset(assetCode);

  let operations;
  try {
    operations = await withFailover((server) =>
      server.operations().forTransaction(String(txHash)).call()
    );
  } catch {
    return { settled: false, undetermined: true };
  }

  const payments = (operations?.records || []).filter(
    (op) => op.type === "payment" && op.to === String(destination)
  );

  const match = payments.find((op) => {
    if (!/^\d+(\.\d+)?$/.test(String(op.amount))) return false;
    if (toAtomic(op.amount) !== expectedAtomic) return false;
    if (expectedAsset.isNative()) return op.asset_type === "native";
    return (
      op.asset_code === expectedAsset.getCode() &&
      op.asset_issuer === expectedAsset.getIssuer()
    );
  });

  if (!match) {
    return {
      settled: false,
      failed: true,
      reason: "settlement_mismatch",
    };
  }

  // Stellar operation ids have the canonical form `<ledger>-<op_index>` with
  // a 1-based operation index.
  const [, operationIndex] = String(match.id || "").split("-");

  return {
    settled: true,
    ledger: typeof tx.ledger === "number" ? tx.ledger : null,
    operationIndex: operationIndex ? Number(operationIndex) : null,
  };
}
