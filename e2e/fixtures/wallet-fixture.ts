/**
 * Playwright Wallet Fixture & Test Extensions.
 *
 * Injects deterministic dummy wallet adapter and network mocking into test pages.
 */

import { test as base, expect, Page } from '@playwright/test';
import {
  createDummyWalletInitScript,
  DEFAULT_TEST_WALLET_ADDRESS,
  DEFAULT_TEST_WALLET_ID,
  DEFAULT_NETWORK_PASSPHRASE,
  DummyWalletConfig,
} from '../adapters/dummy-wallet-adapter';
import {
  setupNetworkMocks,
  NetworkMockController,
  CombinedNetworkMockOptions,
} from '../helpers/network-interception';

export interface DummyWalletFixture {
  address: string;
  walletId: string;
  networkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setAutoApprove: (autoApprove: boolean) => Promise<void>;
  setAddress: (address: string) => Promise<void>;
  rejectNextSignature: (reason?: string) => Promise<void>;
  getSignedTransactions: () => Promise<Array<{ xdr: string; timestamp: number }>>;
  getHistory: () => Promise<Array<{ type: string; payload: any; timestamp: number }>>;
}

export interface WalletTestFixtures {
  dummyWallet: DummyWalletFixture;
  mockNetwork: NetworkMockController;
  walletConfig: DummyWalletConfig;
  networkConfig: CombinedNetworkMockOptions;
}

export const test = base.extend<WalletTestFixtures>({
  // Default configuration options (can be overridden per test)
  walletConfig: [
    {
      address: DEFAULT_TEST_WALLET_ADDRESS,
      walletId: DEFAULT_TEST_WALLET_ID,
      networkPassphrase: DEFAULT_NETWORK_PASSPHRASE,
      autoApprove: true,
      preConnected: true,
    },
    { option: true },
  ],

  networkConfig: [
    {
      trustlessWork: { scenario: 'success' },
      stellar: { rpcScenario: 'success', delayPollAttempts: 0 },
    },
    { option: true },
  ],

  // Injected dummy wallet adapter controller
  dummyWallet: async ({ page, walletConfig }, use) => {
    const initScript = createDummyWalletInitScript(walletConfig);
    await page.addInitScript(initScript);

    const controller: DummyWalletFixture = {
      address: walletConfig.address || DEFAULT_TEST_WALLET_ADDRESS,
      walletId: walletConfig.walletId || DEFAULT_TEST_WALLET_ID,
      networkPassphrase: walletConfig.networkPassphrase || DEFAULT_NETWORK_PASSPHRASE,

      connect: async () => {
        await page.evaluate(() => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (w) {
            return w.authModal();
          }
        });
      },

      disconnect: async () => {
        await page.evaluate(() => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (w) {
            return w.disconnect();
          }
        });
      },

      setAutoApprove: async (autoApprove: boolean) => {
        await page.evaluate((val) => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (w) {
            w.setAutoApprove(val);
          }
        }, autoApprove);
      },

      setAddress: async (newAddress: string) => {
        await page.evaluate((val) => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (w) {
            w.setAddress(val);
          }
        }, newAddress);
        controller.address = newAddress;
      },

      rejectNextSignature: async (reason: string = 'User rejected signature') => {
        await page.evaluate((r) => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (w) {
            w.setAutoApprove(false);
            w.setRejectionReason(r);
          }
        }, reason);
      },

      getSignedTransactions: async () => {
        return await page.evaluate(() => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (!w) return [];
          return w.history
            .filter((item: any) => item.type === 'signTransaction')
            .map((item: any) => ({
              xdr: item.payload.xdr,
              timestamp: item.timestamp,
            }));
        });
      },

      getHistory: async () => {
        return await page.evaluate(() => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
          if (!w) return [];
          return w.getHistory();
        });
      },
    };

    await use(controller);
  },

  mockNetwork: async ({ page, networkConfig }, use) => {
    const networkController = await setupNetworkMocks(page, networkConfig);
    await use(networkController);
  },
});

export { expect };
