import { withFailover } from '@/lib/stellar/horizonClient';
import { applyIndexedEvent } from '@/lib/indexer/stellarIndexer';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';
import logger from '@/lib/logger';

const DEFAULT_LOOKBACK_LEDGERS = Number(process.env.RECOVERY_LOOKBACK_LEDGERS || 200);
const DEFAULT_ACCOUNT = process.env.STELLAR_ADMIN_PUBLIC_KEY || '';

/**
 * Fetch recent payment operations for `accountId` from Horizon and return
 * only those whose transaction hash is NOT already recorded in the database.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {string} params.accountId   - Stellar G-address to audit
 * @param {number} [params.limit]     - Maximum Horizon records to scan
 * @returns {Promise<Array<object>>}  - Array of Horizon payment operation records that are missing
 */
export async function findMissingTransactions({ db, accountId, limit = 200 }) {
  if (!accountId) throw new Error('findMissingTransactions: accountId is required');

  const operations = await withFailover((server) =>
    server
      .payments()
      .forAccount(accountId)
      .limit(limit)
      .order('desc')
      .call()
  );

  const records = operations?.records ?? [];

  // Collect all transaction hashes present on-chain.
  const onChainHashes = records.map((op) => op.transaction_hash).filter(Boolean);

  if (onChainHashes.length === 0) return [];

  // Check which hashes are already indexed.
  const existing = await db
    .collection(COLLECTIONS.purchases)
    .find({ chainTxHash: { $in: onChainHashes } }, { projection: { chainTxHash: 1 } })
    .toArray();

  const indexedSet = new Set(existing.map((doc) => doc.chainTxHash));

  const missing = records.filter(
    (op) => op.transaction_hash && !indexedSet.has(op.transaction_hash)
  );

  logger.info(
    { accountId, scanned: records.length, alreadyIndexed: indexedSet.size, missing: missing.length },
    'Recovery audit complete'
  );

  return missing;
}

/**
 * Convert a Horizon payment operation record into the normalised event shape
 * expected by `applyIndexedEvent`.
 *
 * @param {object} op  - Horizon payment operation record
 * @returns {object}   - Normalised event object
 */
function operationToEvent(op) {
  return {
    id: op.transaction_hash,
    type: 'purchase.completed',
    ledger: op.ledger_attr ?? null,
    transactionHash: op.transaction_hash,
    buyerAddress: op.from,
    sellerAddress: op.to,
    amount: op.amount,
    asset: op.asset_code || 'XLM',
    source: 'recovery',
  };
}

/**
 * Re-process a list of missing Horizon operation records into the database.
 * Guards against duplicate writes using the upsert logic in `applyIndexedEvent`.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {Array<object>} params.operations  - Missing Horizon operation records
 * @returns {Promise<{ recovered: number, skipped: number, errors: string[] }>}
 */
export async function reprocessMissingTransactions({ db, operations }) {
  let recovered = 0;
  let skipped = 0;
  const errors = [];

  for (const op of operations) {
    const event = operationToEvent(op);

    try {
      const result = await applyIndexedEvent(db, event);
      if (result.skipped) {
        skipped += 1;
      } else {
        recovered += 1;
        logger.info({ txHash: op.transaction_hash }, 'Recovery: transaction re-indexed');
      }
    } catch (err) {
      errors.push(`${op.transaction_hash}: ${err.message}`);
      logger.error({ txHash: op.transaction_hash, err: err.message }, 'Recovery: failed to re-index transaction');
    }
  }

  return { recovered, skipped, errors };
}

/**
 * Full recovery run: audit Horizon against the database, then re-index any
 * missing transactions.  Safe to run repeatedly — duplicate-write protection
 * is handled inside `applyIndexedEvent` via upsert semantics.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {string} [params.accountId]  - Stellar address to audit (defaults to STELLAR_ADMIN_PUBLIC_KEY)
 * @param {number} [params.limit]      - Horizon scan limit
 * @returns {Promise<{ recovered: number, skipped: number, errors: string[] }>}
 */
export async function runRecovery({ db, accountId = DEFAULT_ACCOUNT, limit = DEFAULT_LOOKBACK_LEDGERS }) {
  logger.info({ accountId, limit }, 'Starting Stellar indexer recovery run');

  const missing = await findMissingTransactions({ db, accountId, limit });

  if (missing.length === 0) {
    logger.info('Recovery: no missing transactions found');
    return { recovered: 0, skipped: 0, errors: [] };
  }

  const result = await reprocessMissingTransactions({ db, operations: missing });

  logger.info(result, 'Recovery run complete');
  return result;
}
