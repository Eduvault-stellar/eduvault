import { describe, it, expect } from 'vitest';
import {
  STELLAR_MAX_OPERATIONS_PER_TRANSACTION,
  normalizeRecipients,
  chunkRecipients,
  createBulkFundingPlan,
  createChunkRunState,
  applyChunkResult,
  getResumableChunkIds,
  summarizeRunState,
  isRunComplete,
  ChunkStatus,
} from '../bulkFunding';

// Generate syntactically valid, distinct Stellar G-addresses (55 chars
// after 'G') by base32-encoding the seed and left-padding with 'A' (the
// base32 zero digit), so each distinct seed yields a distinct address.
function makeAddress(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let suffix = '';
  let n = seed;
  do {
    suffix = alphabet[n % 32] + suffix;
    n = Math.floor(n / 32);
  } while (n > 0);
  return `G${suffix.padStart(55, 'A')}`;
}

describe('normalizeRecipients', () => {
  it('trims, uppercases, and passes through valid addresses', () => {
    const addr = makeAddress(1);
    const { addresses, invalid, duplicates } = normalizeRecipients([`  ${addr.toLowerCase()}  `]);
    expect(addresses).toEqual([addr]);
    expect(invalid).toEqual([]);
    expect(duplicates).toEqual([]);
  });

  it('flags malformed addresses as invalid instead of silently dropping them', () => {
    const { addresses, invalid } = normalizeRecipients(['not-an-address', 'GSHORT']);
    expect(addresses).toEqual([]);
    expect(invalid).toEqual(['NOT-AN-ADDRESS', 'GSHORT']);
  });

  it('de-duplicates repeated recipients', () => {
    const addr = makeAddress(2);
    const { addresses, duplicates } = normalizeRecipients([addr, addr, addr.toLowerCase()]);
    expect(addresses).toEqual([addr]);
    expect(duplicates).toHaveLength(2);
  });

  it('ignores blank lines', () => {
    const addr = makeAddress(3);
    const { addresses } = normalizeRecipients(['', '   ', addr]);
    expect(addresses).toEqual([addr]);
  });
});

describe('chunkRecipients', () => {
  it('reproduces the unchunked-bulk-submission bug: a naive single request', () => {
    // Regression guard: before this fix, the checkout flow had no chunking
    // at all, so a bulk sponsorship of more than 100 recipients would be
    // represented as a single unit of work. That single unit necessarily
    // exceeds Stellar's per-transaction operation limit.
    const addresses = Array.from({ length: 250 }, (_, i) => makeAddress(i + 1));
    const naiveSingleRequestOpCount = addresses.length;
    expect(naiveSingleRequestOpCount).toBeGreaterThan(STELLAR_MAX_OPERATIONS_PER_TRANSACTION);

    // The fix: chunking keeps every chunk within the limit.
    const chunks = chunkRecipients(addresses);
    for (const chunk of chunks) {
      expect(chunk.opCount).toBeLessThanOrEqual(STELLAR_MAX_OPERATIONS_PER_TRANSACTION);
    }
  });

  it('splits recipients into ceil(n / max) chunks at the default (max) size', () => {
    const addresses = Array.from({ length: 250 }, (_, i) => makeAddress(i + 1));
    const chunks = chunkRecipients(addresses);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].addresses).toHaveLength(100);
    expect(chunks[1].addresses).toHaveLength(100);
    expect(chunks[2].addresses).toHaveLength(50);
  });

  it('preserves recipient order and produces no gaps or overlaps across chunks', () => {
    const addresses = Array.from({ length: 205 }, (_, i) => makeAddress(i + 1));
    const chunks = chunkRecipients(addresses, 50);
    const flattened = chunks.flatMap((c) => c.addresses);
    expect(flattened).toEqual(addresses);
    expect(chunks.map((c) => c.opCount)).toEqual([50, 50, 50, 50, 5]);
  });

  it('assigns deterministic, stable chunk ids and indices', () => {
    const addresses = Array.from({ length: 10 }, (_, i) => makeAddress(i + 1));
    const chunks = chunkRecipients(addresses, 4);
    expect(chunks.map((c) => c.id)).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('clamps an oversized requested chunk size down to the protocol max', () => {
    const addresses = Array.from({ length: 150 }, (_, i) => makeAddress(i + 1));
    const chunks = chunkRecipients(addresses, 1000);
    expect(chunks[0].opCount).toBeLessThanOrEqual(STELLAR_MAX_OPERATIONS_PER_TRANSACTION);
    expect(chunks).toHaveLength(2);
  });

  it('returns no chunks for an empty recipient list', () => {
    expect(chunkRecipients([])).toEqual([]);
  });
});

describe('createBulkFundingPlan', () => {
  it('combines normalization and chunking end to end', () => {
    const valid = Array.from({ length: 120 }, (_, i) => makeAddress(i + 1));
    const raw = [...valid, valid[0], 'bad-address'];
    const plan = createBulkFundingPlan(raw);

    expect(plan.totalRecipients).toBe(120);
    expect(plan.totalChunks).toBe(2);
    expect(plan.invalidAddresses).toEqual(['BAD-ADDRESS']);
    expect(plan.duplicateAddresses).toHaveLength(1);
  });
});

describe('recoverable chunk run state', () => {
  it('starts every chunk as pending', () => {
    const chunks = chunkRecipients(
      Array.from({ length: 10 }, (_, i) => makeAddress(i + 1)),
      4,
    );
    const state = createChunkRunState(chunks);
    expect(Object.keys(state)).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
    for (const entry of Object.values(state)) {
      expect(entry.status).toBe(ChunkStatus.Pending);
    }
  });

  it('retrying after a partial failure only resubmits unresolved chunks', () => {
    const chunks = chunkRecipients(
      Array.from({ length: 10 }, (_, i) => makeAddress(i + 1)),
      4,
    );
    let state = createChunkRunState(chunks);

    state = applyChunkResult(state, 'chunk-0', { status: ChunkStatus.Success, txHash: 'h0' });
    state = applyChunkResult(state, 'chunk-1', { status: ChunkStatus.Failed, error: 'boom' });
    // chunk-2 stays pending, e.g. because the run stopped after chunk-1 failed.

    const resumable = getResumableChunkIds(state);
    expect(resumable.sort()).toEqual(['chunk-1', 'chunk-2']);
    expect(resumable).not.toContain('chunk-0');

    const summaryBefore = summarizeRunState(state);
    expect(summaryBefore).toEqual({ total: 3, success: 1, failed: 1, pending: 1, submitting: 0 });
    expect(isRunComplete(state)).toBe(false);

    // Retry succeeds on the resumable chunks; already-successful chunk-0 is
    // never touched again.
    state = applyChunkResult(state, 'chunk-1', { status: ChunkStatus.Success, txHash: 'h1' });
    state = applyChunkResult(state, 'chunk-2', { status: ChunkStatus.Success, txHash: 'h2' });

    expect(isRunComplete(state)).toBe(true);
    expect(state['chunk-0'].txHash).toBe('h0');
  });

  it('is not complete for an empty run', () => {
    expect(isRunComplete({})).toBe(false);
  });
});
