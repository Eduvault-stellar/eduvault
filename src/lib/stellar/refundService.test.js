/**
 * Unit test for src/lib/stellar/refundService.js — Issue #137
 *
 * Before this fix, `refundService.js` derived its own `isMainnet` by
 * comparing `NEXT_PUBLIC_STELLAR_NETWORK` against lowercase `'mainnet'`,
 * independently of `src/lib/config/chain.js`'s (and `historyFeed.js`'s)
 * uppercase `'PUBLIC'` check. This proves the signed transaction's
 * `networkPassphrase` now comes from -- and therefore always agrees with --
 * `chain.js`'s single validated `NETWORK_PASSPHRASE`, using the real
 * (unmocked) chain.js module so the assertion reflects genuine agreement,
 * not two mocks that happen to match.
 *
 * Run with: npm test (vitest)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Account } from '@stellar/stellar-sdk';

const mockLoadAccount = vi.fn();
const mockSubmitTransaction = vi.fn();
const mockCalculateDynamicFee = vi.fn();

vi.mock('./horizonClient', () => ({
  loadAccount: (...args) => mockLoadAccount(...args),
  submitTransaction: (...args) => mockSubmitTransaction(...args),
}));

vi.mock('./checkoutService', () => ({
  calculateDynamicFee: (...args) => mockCalculateDynamicFee(...args),
}));

describe('approveRefundOnChain network passphrase (#137)', () => {
  const adminKeypair = Keypair.random();

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STELLAR_ADMIN_SECRET = adminKeypair.secret();
    mockLoadAccount.mockResolvedValue(new Account(adminKeypair.publicKey(), '123456789'));
    mockCalculateDynamicFee.mockResolvedValue({ feeStroops: 100, surging: false, p95Fee: 100 });
    mockSubmitTransaction.mockResolvedValue({ hash: 'fake-tx-hash' });
  });

  it('signs the refund transaction with chain.js\'s NETWORK_PASSPHRASE, not a locally-derived one', async () => {
    const { NETWORK_PASSPHRASE } = await import('@/lib/config/chain');
    const { approveRefundOnChain } = await import('./refundService.js');

    await approveRefundOnChain('claim-1', Keypair.random().publicKey(), '10', 'XLM');

    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    const submittedTx = mockSubmitTransaction.mock.calls[0][0];
    expect(submittedTx.networkPassphrase).toBe(NETWORK_PASSPHRASE);
  });
});
