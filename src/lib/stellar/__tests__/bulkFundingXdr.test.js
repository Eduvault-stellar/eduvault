import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Account, TransactionBuilder, Networks } from '@stellar/stellar-sdk';

vi.mock('../horizonClient', () => ({
  loadAccount: vi.fn(),
}));

import { loadAccount } from '../horizonClient';
import { buildBulkFundingTransactions, buildSingleChunkTransaction } from '../bulkFundingXdr';
import { STELLAR_MAX_OPERATIONS_PER_TRANSACTION } from '../bulkFunding';

const SOURCE = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

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

describe('buildBulkFundingTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAccount.mockImplementation(async (pk) => new Account(pk, '100'));
  });

  it('builds one transaction per chunk, each within the operation limit', async () => {
    const recipients = Array.from({ length: 250 }, (_, i) => makeAddress(i + 1));

    const built = await buildBulkFundingTransactions({
      sourcePublicKey: SOURCE,
      recipients,
      amountPerRecipient: '5',
    });

    expect(built).toHaveLength(3);
    expect(built.map((b) => b.opCount)).toEqual([100, 100, 50]);

    for (const chunk of built) {
      const tx = TransactionBuilder.fromXDR(chunk.xdr, Networks.TESTNET);
      expect(tx.operations).toHaveLength(chunk.opCount);
      expect(tx.operations.length).toBeLessThanOrEqual(STELLAR_MAX_OPERATIONS_PER_TRANSACTION);
      for (const op of tx.operations) {
        expect(op.type).toBe('payment');
        expect(op.amount).toBe('5.0000000');
      }
    }
  });

  it('assigns strictly increasing sequence numbers across chunks', async () => {
    const recipients = Array.from({ length: 150 }, (_, i) => makeAddress(i + 1));

    const built = await buildBulkFundingTransactions({
      sourcePublicKey: SOURCE,
      recipients,
      amountPerRecipient: '1',
    });

    const sequences = built.map(
      (chunk) => TransactionBuilder.fromXDR(chunk.xdr, Networks.TESTNET).sequence,
    );
    expect(sequences).toEqual(['101', '102']);
  });

  it('rejects a non-positive amount', async () => {
    await expect(
      buildBulkFundingTransactions({
        sourcePublicKey: SOURCE,
        recipients: [makeAddress(1)],
        amountPerRecipient: 0,
      }),
    ).rejects.toThrow(/positive number/);
  });

  it('rejects when no source public key is provided', async () => {
    await expect(
      buildBulkFundingTransactions({
        recipients: [makeAddress(1)],
        amountPerRecipient: '1',
      }),
    ).rejects.toThrow(/sourcePublicKey/);
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      buildBulkFundingTransactions({
        sourcePublicKey: SOURCE,
        recipients: [],
        amountPerRecipient: '1',
      }),
    ).rejects.toThrow(/No valid recipients/);
  });
});

describe('buildSingleChunkTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAccount.mockImplementation(async (pk) => new Account(pk, '5'));
  });

  it('re-loads the source account so a retried chunk uses a fresh sequence number', async () => {
    const addresses = [makeAddress(1), makeAddress(2)];

    await buildSingleChunkTransaction({
      sourcePublicKey: SOURCE,
      addresses,
      amountPerRecipient: '1',
    });
    await buildSingleChunkTransaction({
      sourcePublicKey: SOURCE,
      addresses,
      amountPerRecipient: '1',
    });

    expect(loadAccount).toHaveBeenCalledTimes(2);
  });
});
