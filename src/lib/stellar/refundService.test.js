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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

/**
 * Regression coverage for issue #138.
 *
 * Before this fix, a missing `NEXT_PUBLIC_USDC_ISSUER` made `refundService.js`
 * silently fall back to signing the payment with the *admin account* as the
 * asset issuer (`new Asset(assetCode, ... || adminKeypair.publicKey())`).
 * That constructs a Stellar `Asset` that shares USDC's code but is a
 * completely different, worthless asset -- the refund would "succeed" while
 * paying out nothing of real value, with no error raised anywhere.
 */
describe('approveRefundOnChain USDC issuer fail-closed behavior (#138)', () => {
  const adminKeypair = Keypair.random();
  const originalIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STELLAR_ADMIN_SECRET = adminKeypair.secret();
    mockLoadAccount.mockResolvedValue(new Account(adminKeypair.publicKey(), '123456789'));
    mockCalculateDynamicFee.mockResolvedValue({ feeStroops: 100, surging: false, p95Fee: 100 });
    mockSubmitTransaction.mockResolvedValue({ hash: 'fake-tx-hash' });
  });

  afterEach(() => {
    if (originalIssuer === undefined) {
      delete process.env.NEXT_PUBLIC_USDC_ISSUER;
    } else {
      process.env.NEXT_PUBLIC_USDC_ISSUER = originalIssuer;
    }
  });

  describe('the fixed bug: no admin-account fallback for the issuer', () => {
    it('never substitutes the admin public key as issuer when NEXT_PUBLIC_USDC_ISSUER is unset', async () => {
      delete process.env.NEXT_PUBLIC_USDC_ISSUER;
      const { approveRefundOnChain } = await import('./refundService.js');

      await expect(
        approveRefundOnChain('claim-1', Keypair.random().publicKey(), '10', 'USDC'),
      ).rejects.toThrow(/Missing NEXT_PUBLIC_USDC_ISSUER/);

      // Fails closed before any network call -- no partial submission, no
      // asset ever constructed with the admin key as issuer.
      expect(mockLoadAccount).not.toHaveBeenCalled();
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
    });

    it.each(['', 'replace-me', 'change-me'])(
      'also fails closed for the placeholder value %j, not just an absent variable',
      async (placeholder) => {
        process.env.NEXT_PUBLIC_USDC_ISSUER = placeholder;
        const { approveRefundOnChain } = await import('./refundService.js');

        await expect(
          approveRefundOnChain('claim-1', Keypair.random().publicKey(), '10', 'USDC'),
        ).rejects.toThrow(/Missing NEXT_PUBLIC_USDC_ISSUER/);
        expect(mockSubmitTransaction).not.toHaveBeenCalled();
      },
    );

    it('does not leak the admin secret or public key in the failure message', async () => {
      delete process.env.NEXT_PUBLIC_USDC_ISSUER;
      const { approveRefundOnChain } = await import('./refundService.js');

      let caught;
      try {
        await approveRefundOnChain('claim-1', Keypair.random().publicKey(), '10', 'USDC');
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(caught.message).not.toContain(adminKeypair.secret());
      expect(caught.message).not.toContain(adminKeypair.publicKey());
    });
  });

  describe('success path with a properly configured issuer', () => {
    it('pays out an asset issued by the configured NEXT_PUBLIC_USDC_ISSUER, not the admin account', async () => {
      const realIssuer = Keypair.random().publicKey();
      process.env.NEXT_PUBLIC_USDC_ISSUER = realIssuer;
      const { approveRefundOnChain } = await import('./refundService.js');

      const result = await approveRefundOnChain('claim-1', Keypair.random().publicKey(), '10', 'USDC');

      expect(result).toEqual({ success: true, hash: 'fake-tx-hash' });
      const submittedTx = mockSubmitTransaction.mock.calls[0][0];
      const paymentOp = submittedTx.operations[0];
      expect(paymentOp.asset.code).toBe('USDC');
      expect(paymentOp.asset.issuer).toBe(realIssuer);
      expect(paymentOp.asset.issuer).not.toBe(adminKeypair.publicKey());
    });
  });

  describe('boundary: XLM refunds never require an issuer', () => {
    it('succeeds for an XLM refund even when NEXT_PUBLIC_USDC_ISSUER is unset', async () => {
      delete process.env.NEXT_PUBLIC_USDC_ISSUER;
      const { approveRefundOnChain } = await import('./refundService.js');

      const result = await approveRefundOnChain('claim-1', Keypair.random().publicKey(), '10', 'XLM');

      expect(result).toEqual({ success: true, hash: 'fake-tx-hash' });
      const submittedTx = mockSubmitTransaction.mock.calls[0][0];
      expect(submittedTx.operations[0].asset.isNative()).toBe(true);
    });
  });
});
