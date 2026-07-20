import { Keypair, TransactionBuilder, Networks, Asset, Operation } from '@stellar/stellar-sdk';
import { loadAccount, submitTransaction } from './horizonClient';
import { calculateDynamicFee } from './checkoutService';

const isMainnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet';
const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;

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

    const adminKeypair = Keypair.fromSecret(adminSecret);
    // Use failover-aware loadAccount (issue #383)
    const adminAccount = await loadAccount(adminKeypair.publicKey());

    // Compute surge-aware fee (issue #385)
    const { feeStroops } = await calculateDynamicFee();

    const paymentOp = Operation.payment({
      destination: destinationAddress,
      asset: assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, process.env.NEXT_PUBLIC_USDC_ISSUER || adminKeypair.publicKey()),
      amount: String(amount),
    });

    let tx = new TransactionBuilder(adminAccount, {
      fee: String(feeStroops),
      networkPassphrase,
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
