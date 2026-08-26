import { Keypair, TransactionBuilder, Asset, Operation } from '@stellar/stellar-sdk';
import { loadAccount, submitTransaction } from './horizonClient';
import { calculateDynamicFee } from './checkoutService';
import { NETWORK_PASSPHRASE } from '@/lib/config/chain';
import { isPlaceholder } from '@/lib/env';

/**
 * Resolves the Stellar `Asset` a refund should be paid out in.
 *
 * `assetCode === 'XLM'` is the only case with no issuer, since XLM is
 * Stellar's native asset. Every other code (currently only `'USDC'` is ever
 * passed) is issued by a specific account, and that issuer **must** come
 * from explicit configuration -- there is no safe default. Substituting the
 * admin's own account as a placeholder issuer (the bug this fixes) does not
 * degrade gracefully: it silently identifies a different, worthless asset
 * that merely shares the same asset code (issue #138).
 */
function resolveRefundAsset(assetCode) {
  if (assetCode === 'XLM') {
    return Asset.native();
  }

  const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
  if (isPlaceholder(issuer)) {
    throw new Error(`Missing NEXT_PUBLIC_USDC_ISSUER configuration for asset "${assetCode}".`);
  }

  return new Asset(assetCode, issuer);
}

/**
 * Service to handle blockchain-level refund approvals.
 * Uses the failover Horizon client and surge-aware dynamic fee.
 */
export async function approveRefundOnChain(claimId, destinationAddress, amount, assetCode = 'USDC') {
  try {

    const adminSecret = process.env.STELLAR_ADMIN_SECRET;
    if (!adminSecret) {
      throw new Error("Missing STELLAR_ADMIN_SECRET configuration.");
    }

    // Resolved before any Horizon call: an unconfigured issuer must fail
    // closed without spending a network round-trip on a refund that cannot
    // safely proceed (issue #138).
    const refundAsset = resolveRefundAsset(assetCode);

    const adminKeypair = Keypair.fromSecret(adminSecret);
    // Use failover-aware loadAccount (issue #383)
    const adminAccount = await loadAccount(adminKeypair.publicKey());

    // Compute surge-aware fee (issue #385)
    const { feeStroops } = await calculateDynamicFee();

    const paymentOp = Operation.payment({
      destination: destinationAddress,
      asset: refundAsset,
      amount: String(amount),
    });

    let tx = new TransactionBuilder(adminAccount, {
      fee: String(feeStroops),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(paymentOp)
      .setTimeout(30)
      .build();

    tx.sign(adminKeypair);

    // Use failover-aware submitTransaction (issue #383)
    const transactionResult = await submitTransaction(tx);
    return {
      success: true,
      hash: transactionResult.hash,
    };
  } catch (error) {
    console.error("Error in approveRefundOnChain:", error);
    throw new Error(`Refund failed: ${error?.response?.data?.extras?.result_codes?.transaction || error.message}`);
  }
}
