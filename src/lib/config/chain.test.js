/**
 * Unit tests for src/lib/config/chain.js — Issue #137
 *
 * Regression coverage for the bug this fix closes: `refundService.js` used
 * to derive "is this mainnet" by comparing against lowercase `'mainnet'`,
 * while `historyFeed.js` (and this file) compared against uppercase
 * `'PUBLIC'`. A single `NEXT_PUBLIC_STELLAR_NETWORK` value could therefore
 * be interpreted as mainnet by one module and testnet by another, letting a
 * transaction be signed with one network's passphrase while being submitted
 * to the other network's Horizon endpoint.
 *
 * These tests exercise `chain.js` as the single validated source of truth
 * both consumers now import from, proving `NETWORK_PASSPHRASE`,
 * `HORIZON_URL`, and `isMainnet` always agree for the same env value.
 *
 * Run with: npm test (vitest)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

describe('Stellar network resolution (#137)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    vi.resetModules();
  });

  describe('the fixed bug: mainnet detection now agrees across every export', () => {
    const mainnetAliases = ['mainnet', 'PUBLIC', 'public', 'MAINNET', 'Public'];

    it.each(mainnetAliases)(
      'treats "%s" as mainnet consistently in NETWORK_PASSPHRASE, HORIZON_URL, and isMainnet',
      async (value) => {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = value;
        delete process.env.NEXT_PUBLIC_HORIZON_URL;
        const { NETWORK_PASSPHRASE, HORIZON_URL, isMainnet } = await import('./chain.js');
        const { Networks } = await import('@stellar/stellar-sdk');

        expect(isMainnet).toBe(true);
        expect(NETWORK_PASSPHRASE).toBe(Networks.PUBLIC);
        expect(HORIZON_URL).toBe('https://horizon.stellar.org');
      },
    );

    const testnetAliases = ['testnet', 'TESTNET', 'TestNet'];

    it.each(testnetAliases)(
      'treats "%s" as testnet consistently in NETWORK_PASSPHRASE, HORIZON_URL, and isMainnet',
      async (value) => {
        process.env.NEXT_PUBLIC_STELLAR_NETWORK = value;
        delete process.env.NEXT_PUBLIC_HORIZON_URL;
        const { NETWORK_PASSPHRASE, HORIZON_URL, isMainnet } = await import('./chain.js');
        const { Networks } = await import('@stellar/stellar-sdk');

        expect(isMainnet).toBe(false);
        expect(NETWORK_PASSPHRASE).toBe(Networks.TESTNET);
        expect(HORIZON_URL).toBe('https://horizon-testnet.stellar.org');
      },
    );
  });

  describe('backward compatibility: unset/blank still defaults to testnet', () => {
    it('defaults to testnet when NEXT_PUBLIC_STELLAR_NETWORK is unset', async () => {
      delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
      const { isMainnet } = await import('./chain.js');
      expect(isMainnet).toBe(false);
    });

    it('defaults to testnet when NEXT_PUBLIC_STELLAR_NETWORK is an empty string', async () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = '';
      const { isMainnet } = await import('./chain.js');
      expect(isMainnet).toBe(false);
    });

    it('tolerates surrounding whitespace', async () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = '  mainnet  ';
      const { isMainnet } = await import('./chain.js');
      expect(isMainnet).toBe(true);
    });
  });

  describe('fails safely on an invalid value instead of silently defaulting to testnet', () => {
    const invalidValues = ['produciton', 'mainet', 'Public Network', 'live', '1'];

    it.each(invalidValues)('throws a clear, actionable error for "%s"', async (value) => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = value;
      await expect(import('./chain.js')).rejects.toThrow(/Invalid NEXT_PUBLIC_STELLAR_NETWORK/);
    });

    it('includes the offending value and the accepted values in the error message', async () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainet';
      await expect(import('./chain.js')).rejects.toThrow(
        /"mainet".*"mainnet".*"public".*"testnet"/is,
      );
    });
  });

  describe('NEXT_PUBLIC_HORIZON_URL explicit override still takes precedence', () => {
    it('uses the explicit override regardless of the resolved network', async () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';
      process.env.NEXT_PUBLIC_HORIZON_URL = 'https://custom-horizon.example.com';
      const { HORIZON_URL } = await import('./chain.js');
      expect(HORIZON_URL).toBe('https://custom-horizon.example.com');
    });
  });
});
