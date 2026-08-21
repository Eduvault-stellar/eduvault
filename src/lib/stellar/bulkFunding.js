/**
 * bulkFunding - Issue #158
 *
 * Pure helpers for chunking bulk sponsor-funding recipient lists so that
 * every on-chain transaction we build stays within Stellar's per-transaction
 * operation limit, plus a small recoverable state machine so a partially
 * failed bulk run can be retried without re-sending chunks that already
 * succeeded (idempotent-by-chunk recovery).
 *
 * Nothing here talks to the network - see bulkFundingXdr.js for the part
 * that turns a chunk into a signable Stellar transaction.
 */

// Stellar protocol hard limit: a transaction envelope may contain at most
// 100 operations. Going over this is rejected outright by validators, so
// every chunk must stay at or under this ceiling regardless of any
// configured chunk size.
export const STELLAR_MAX_OPERATIONS_PER_TRANSACTION = 100;

const G_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

function resolveChunkSize(chunkSize) {
  const requested = Number(
    chunkSize ??
      process.env.NEXT_PUBLIC_BULK_FUNDING_CHUNK_SIZE ??
      STELLAR_MAX_OPERATIONS_PER_TRANSACTION,
  );

  if (!Number.isFinite(requested) || requested < 1) {
    return STELLAR_MAX_OPERATIONS_PER_TRANSACTION;
  }

  return Math.min(Math.floor(requested), STELLAR_MAX_OPERATIONS_PER_TRANSACTION);
}

/**
 * Validate and de-duplicate a raw list of recipient address strings.
 *
 * @param {string[]} rawAddresses
 * @returns {{ addresses: string[], invalid: string[], duplicates: string[] }}
 */
export function normalizeRecipients(rawAddresses = []) {
  const seen = new Set();
  const addresses = [];
  const invalid = [];
  const duplicates = [];

  for (const raw of rawAddresses) {
    const address = String(raw ?? '').trim().toUpperCase();
    if (!address) continue;

    if (!G_ADDRESS_REGEX.test(address)) {
      invalid.push(address);
      continue;
    }

    if (seen.has(address)) {
      duplicates.push(address);
      continue;
    }

    seen.add(address);
    addresses.push(address);
  }

  return { addresses, invalid, duplicates };
}

/**
 * Split a list of (already validated) recipient addresses into chunks that
 * each stay within the Stellar per-transaction operation limit.
 *
 * @param {string[]} addresses
 * @param {number} [chunkSize] - optional override, clamped to the protocol max
 * @returns {{ id: string, index: number, addresses: string[], opCount: number }[]}
 */
export function chunkRecipients(addresses, chunkSize) {
  const size = resolveChunkSize(chunkSize);
  const list = Array.isArray(addresses) ? addresses : [];
  const chunks = [];

  for (let i = 0; i < list.length; i += size) {
    const slice = list.slice(i, i + size);
    const index = chunks.length;
    chunks.push({
      id: `chunk-${index}`,
      index,
      addresses: slice,
      opCount: slice.length,
    });
  }

  return chunks;
}

/**
 * Build the full bulk-funding plan for a raw recipient list: validate,
 * de-duplicate, and chunk within resource limits.
 *
 * @param {string[]} rawAddresses
 * @param {{ chunkSize?: number }} [options]
 */
export function createBulkFundingPlan(rawAddresses, { chunkSize } = {}) {
  const { addresses, invalid, duplicates } = normalizeRecipients(rawAddresses);
  const chunks = chunkRecipients(addresses, chunkSize);

  return {
    chunks,
    totalRecipients: addresses.length,
    totalChunks: chunks.length,
    invalidAddresses: invalid,
    duplicateAddresses: duplicates,
  };
}

// --- Recoverable per-chunk run state ---------------------------------------

export const ChunkStatus = Object.freeze({
  Pending: 'pending',
  Submitting: 'submitting',
  Success: 'success',
  Failed: 'failed',
});

/**
 * Create the initial recoverable run state for a set of chunks. Each chunk
 * is tracked independently so a bulk run can be resumed after a partial
 * failure without re-submitting chunks that already succeeded.
 */
export function createChunkRunState(chunks) {
  const state = {};
  for (const chunk of chunks) {
    state[chunk.id] = {
      status: ChunkStatus.Pending,
      attempts: 0,
      error: null,
      txHash: null,
    };
  }
  return state;
}

/**
 * Apply a status patch to one chunk, returning a new state object
 * (immutable update - safe to use directly in React state setters).
 */
export function applyChunkResult(runState, chunkId, patch) {
  const current = runState[chunkId] ?? {
    status: ChunkStatus.Pending,
    attempts: 0,
    error: null,
    txHash: null,
  };

  return {
    ...runState,
    [chunkId]: {
      ...current,
      ...patch,
    },
  };
}

/**
 * Chunk ids that still need to be (re)submitted - i.e. everything that has
 * not already succeeded. Used to drive retries after a partial failure
 * without resubmitting successful, already-funded chunks.
 */
export function getResumableChunkIds(runState) {
  return Object.entries(runState)
    .filter(([, entry]) => entry.status !== ChunkStatus.Success)
    .map(([chunkId]) => chunkId);
}

export function summarizeRunState(runState) {
  const entries = Object.values(runState);
  return {
    total: entries.length,
    success: entries.filter((e) => e.status === ChunkStatus.Success).length,
    failed: entries.filter((e) => e.status === ChunkStatus.Failed).length,
    pending: entries.filter((e) => e.status === ChunkStatus.Pending).length,
    submitting: entries.filter((e) => e.status === ChunkStatus.Submitting).length,
  };
}

export function isRunComplete(runState) {
  const entries = Object.values(runState);
  return entries.length > 0 && entries.every((e) => e.status === ChunkStatus.Success);
}
