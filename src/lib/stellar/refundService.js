import { Keypair, Server, TransactionBuilder, Networks, Asset, Operation } from '@stellar/stellar-sdk';

/**
 * Service to handle blockchain-level refund approvals.
 */
export async function approveRefundOnChain(claimId, destinationAddress, amount, assetCode = 'USDC') {
  try {
    const isMainnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet';
    const serverUrl = isMainnet
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
    const server = new Server(serverUrl);
    const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;

    const adminSecret = process.env.STELLAR_ADMIN_SECRET;
    if (!adminSecret) {
      throw new Error("Missing STELLAR_ADMIN_SECRET configuration.");
    }

    const adminKeypair = Keypair.fromSecret(adminSecret);
    const adminAccount = await server.loadAccount(adminKeypair.publicKey());

    // NOTE: This assumes standard Stellar operations for sending back the refund.
    // If a specific smart contract is used, this would call the contract method.
    // Here we perform a standard payment operation to refund the user.
    
    // In Soroban smart-contract, you would build a contract call:
    // const contractId = process.env.REFUND_CONTRACT_ID;
    // const contract = new Contract(contractId);
    // const tx = new TransactionBuilder(adminAccount, { ... })
    //     .addOperation(contract.call("approve_refund", ...))
    
    // For the sake of standard Stellar network refunds:
    const paymentOp = Operation.payment({
      destination: destinationAddress,
      asset: assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, process.env.NEXT_PUBLIC_USDC_ISSUER || adminKeypair.publicKey()),
      amount: String(amount),
    });

    let tx = new TransactionBuilder(adminAccount, {
      fee: "1000",
      networkPassphrase,
    })
      .addOperation(paymentOp)
      .setTimeout(30)
      .build();

    tx.sign(adminKeypair);

    const transactionResult = await server.submitTransaction(tx);
    return {
      success: true,
      hash: transactionResult.hash,
    };
  } catch (error) {
    console.error("Error in approveRefundOnChain:", error);
    throw new Error(`Refund failed: ${error?.response?.data?.extras?.result_codes?.transaction || error.message}`);
  }
}
