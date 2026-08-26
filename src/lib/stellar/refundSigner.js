/**
 * Constrained refund signer (#27).
 *
 * This module is the ONLY place in the codebase that loads a refund-signing
 * key. Route handlers and services never see key material; they ask this
 * signer to perform one narrowly-scoped operation: pay a fixed amount to a
 * pre-approved destination that was derived from the purchase receipt.
 *
 * Key management controls (documented contract):
 *
 *  - Least privilege: REFUND_SIGNER_SECRET must be a DEDICATED Stellar
 *    account used solely for refunds - never the general platform admin key
 *    (STELLAR_ADMIN_SECRET). The account holds only the treasury float needed
 *    for expected refund volume and is topped up from a cold wallet.
 *  - Rotation: rotating the key is an environment-variable change
 *    (REFUND_SIGNER_SECRET); no state in MongoDB references the old key.
 *  - Emergency disable: setting REFUNDS_EMERGENCY_DISABLE=true stops all
 *    outbound refund payments immediately while leaving claims readable and
 *    approvable; settlements resume as soon as the flag is cleared.
 *  - Spend ceiling: REFUND_MAX_SINGLE_UNITS caps any single payment so a
 *    compromised runtime cannot drain the hot wallet in one transaction.
 */

import { Keypair, TransactionBuilder, Networks, Asset, Operation } from "@stellar/stellar-sdk";
import { loadAccount, submitTransaction } from "./horizonClient";
import { calculateDynamicFee } from "./checkoutService";

const isMainnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet";
const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;

const KNOWN_ISSUERS = {
  mainnet: {
    USDC: "GA5ZSEJYB37JDD5G3LYVYF77RD7QFGHSXPJNKXJFUMIVYQ33HE6IGM4Y",
  },
  testnet: {
    USDC: "GBBD47IF6LWK7P7MDEVSCWRZDPOVPOFWLYERWFBN4JSE3OUQTISLV5EX",
  },
};

export class RefundSignerError extends Error {
  constructor(message, { classification, txHash } = {}) {
    super(message);
    this.name = "RefundSignerError";
    this.classification = classification;
    this.txHash = txHash;
  }
}

/** Resolve the classic Stellar asset for a stored purchase asset reference. */
export function resolveRefundAsset(assetRef) {
  const code = String(assetRef || "").trim();
  if (!code || code.toLowerCase() === "native" || code.toUpperCase() === "XLM") {
    return Asset.native();
  }

  const issuer =
    process.env.NEXT_PUBLIC_USDC_ISSUER || KNOWN_ISSUERS[isMainnet ? "mainnet" : "testnet"][code];
  if (!issuer) {
    throw new RefundSignerError(
      `No trusted issuer configured for asset '${code}'; refusing to build the refund payment.`,
      { classification: "definitive" }
    );
  }
  return new Asset(code, issuer);
}

/** Fail fast when refunds are administratively disabled or unconfigured. */
export function assertRefundSigningEnabled() {
  if (
    String(process.env.REFUNDS_EMERGENCY_DISABLE || "").toLowerCase() === "true"
  ) {
    throw new RefundSignerError(
      "Refunds are administratively disabled (REFUNDS_EMERGENCY_DISABLE).",
      { classification: "definitive" }
    );
  }
  if (!process.env.REFUND_SIGNER_SECRET) {
    throw new RefundSignerError(
      "Missing REFUND_SIGNER_SECRET configuration; refunds cannot be signed.",
      { classification: "definitive" }
    );
  }
}

/**
 * Build, sign, and submit one refund payment.
 *
 * @param {object} params
 * @param {string} params.destination Buyer address taken from the purchase record.
 * @param {string} params.assetCode   Asset code taken from the purchase record.
 * @param {string} params.amountUnits Integer amount string derived server-side.
 * @returns {Promise<{ txHash: string }>}
 */
export async function submitRefundPayment({ destination, assetCode, amountUnits }) {
  assertRefundSigningEnabled();

  const maxSingleUnits = process.env.REFUND_MAX_SINGLE_UNITS;
  if (
    maxSingleUnits &&
    Number.isFinite(Number(maxSingleUnits)) &&
    Number(amountUnits) > Number(maxSingleUnits)
  ) {
    throw new RefundSignerError(
      `Refund amount ${amountUnits} exceeds REFUND_MAX_SINGLE_UNITS=${maxSingleUnits}.`,
      { classification: "definitive" }
    );
  }

  const adminKeypair = Keypair.fromSecret(process.env.REFUND_SIGNER_SECRET);
  const adminAccount = await loadAccount(adminKeypair.publicKey());
  const { feeStroops } = await calculateDynamicFee();

  let tx;
  try {
    tx = new TransactionBuilder(adminAccount, {
      fee: String(feeStroops),
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination,
          asset: resolveRefundAsset(assetCode),
          amount: String(amountUnits),
        })
      )
      .setTimeout(30)
      .build();
  } catch (err) {
    // Malformed destination/asset/amount never left our runtime.
    throw new RefundSignerError(`Failed to build refund payment: ${err.message}`, {
      classification: "definitive",
    });
  }

  tx.sign(adminKeypair);

  try {
    const submitted = await submitTransaction(tx);
    return { txHash: submitted.hash };
  } catch (err) {
    // A Horizon timeout/connection drop after send is ambiguous: the network
    // may have accepted the payment. Surface the envelope hash so the
    // workflow can park the claim for reconciliation instead of resubmitting.
    const ambiguous =
      err?.code === "ETIMEDOUT" ||
      err?.code === "ECONNRESET" ||
      /timeout|network|socket/i.test(String(err?.message || ""));
    throw new RefundSignerError(
      `Horizon submission failed: ${
        err?.response?.data?.extras?.result_codes?.transaction || err.message
      }`,
      ambiguous ? { classification: "timeout_unknown", txHash: tx.hash() } : {}
    );
  }
}
