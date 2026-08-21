/**
 * bulkFundingXdr - Issue #158
 *
 * Turns a chunked bulk-funding plan (see bulkFunding.js) into unsigned
 * Stellar payment transactions, one per chunk, each holding at most
 * STELLAR_MAX_OPERATIONS_PER_TRANSACTION payment operations so the
 * resulting envelope always stays within Stellar's transaction limits.
 *
 * Sequence numbers for successive chunks are derived from a single loaded
 * source account: @stellar/stellar-sdk's TransactionBuilder increments the
 * account's sequence number on every build(), so reusing the same account
 * object across chunks yields correctly ordered, non-colliding sequence
 * numbers without an extra Horizon round-trip per chunk.
 */

import { TransactionBuilder, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';
import { loadAccount } from './horizonClient';
import { NETWORK_PASSPHRASE } from '@/lib/config/chain';
import { chunkRecipients } from './bulkFunding';

/**
 * Build one unsigned XDR transaction per chunk of recipients.
 *
 * @param {object} params
 * @param {string} params.sourcePublicKey - sponsor's Stellar G-address (fee/tx source)
 * @param {string[]} params.recipients - validated, de-duplicated recipient addresses
 * @param {number|string} params.amountPerRecipient - native XLM amount sent to each recipient
 * @param {number} [params.chunkSize] - optional override, clamped to the protocol max
 * @param {number} [params.timeoutSeconds=180]
 * @param {string} [params.fee=BASE_FEE] - fee in stroops, per operation
 * @returns {Promise<Array<{ chunkId: string, chunkIndex: number, addresses: string[], opCount: number, xdr: string }>>}
 */
export async function buildBulkFundingTransactions({
  sourcePublicKey,
  recipients,
  amountPerRecipient,
  chunkSize,
  timeoutSeconds = 180,
  fee = BASE_FEE,
}) {
  if (!sourcePublicKey) {
    throw new Error('sourcePublicKey is required to build bulk funding transactions');
  }

  const amount = Number(amountPerRecipient);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amountPerRecipient must be a positive number');
  }

  const chunks = chunkRecipients(recipients, chunkSize);
  if (chunks.length === 0) {
    throw new Error('No valid recipients to fund');
  }

  const sourceAccount = await loadAccount(sourcePublicKey);

  return chunks.map((chunk) => {
    const builder = new TransactionBuilder(sourceAccount, {
      fee: String(fee),
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    for (const destination of chunk.addresses) {
      builder.addOperation(
        Operation.payment({
          destination,
          asset: Asset.native(),
          amount: amount.toFixed(7),
        }),
      );
    }

    const transaction = builder.setTimeout(timeoutSeconds).build();

    return {
      chunkId: chunk.id,
      chunkIndex: chunk.index,
      addresses: chunk.addresses,
      opCount: chunk.addresses.length,
      xdr: transaction.toXDR(),
    };
  });
}

/**
 * Build the unsigned transaction for a single chunk. Used when retrying a
 * previously-failed chunk in isolation: the source account is re-loaded so
 * the transaction picks up the sponsor's current on-chain sequence number
 * rather than reusing one that may now be stale.
 *
 * @param {object} params - same shape as buildBulkFundingTransactions, minus chunkSize
 */
export async function buildSingleChunkTransaction({
  sourcePublicKey,
  addresses,
  amountPerRecipient,
  timeoutSeconds,
  fee,
}) {
  const [built] = await buildBulkFundingTransactions({
    sourcePublicKey,
    recipients: addresses,
    amountPerRecipient,
    chunkSize: addresses.length,
    timeoutSeconds,
    fee,
  });
  return built;
}
