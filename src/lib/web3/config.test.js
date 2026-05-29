/**
 * Unit tests for src/lib/web3/config.js — Issue #112
 *
 * Verifies that the wagmi connector list is constructed correctly based on
 * the value of NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
 *
 * Run with: npm test (vitest)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We test wallConnectEnabled directly; full wagmi config requires a browser
// environment that wagmi itself sets up, so we isolate the guard logic.

describe('WalletConnect connector guard (#112)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  it('disables WalletConnect when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is unset', async () => {
    delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    const { walletConnectEnabled } = await import('./config.js');
    expect(walletConnectEnabled).toBe(false);
  });

  it('disables WalletConnect when project ID is the placeholder string', async () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = 'YOUR_PROJECT_ID';
    const { walletConnectEnabled } = await import('./config.js');
    expect(walletConnectEnabled).toBe(false);
  });

  it('disables WalletConnect when project ID is an empty string', async () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = '';
    const { walletConnectEnabled } = await import('./config.js');
    expect(walletConnectEnabled).toBe(false);
  });

  it('enables WalletConnect when a real project ID is set', async () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = 'abc123realprojectid';
    const { walletConnectEnabled } = await import('./config.js');
    expect(walletConnectEnabled).toBe(true);
  });
});
