/**
 * Deterministic Dummy Wallet Adapter for Playwright E2E Tests.
 *
 * Provides a mock Stellar wallet adapter that injects directly into the browser context,
 * bypassing external extension modals/popups and auto-approving transaction and auth-entry
 * signatures deterministically.
 */

export const DEFAULT_TEST_WALLET_ADDRESS =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGX2R7D4FJU6VMS5G5T';

export const DEFAULT_TEST_WALLET_ID = 'dummy-wallet-adapter';

export const DEFAULT_NETWORK_PASSPHRASE =
  'Test SDF Network ; September 2015';

export const SESSION_STORAGE_KEY = 'eduvault.wallet.session.v1';

export const DUMMY_SIGNED_TX_XDR_PREFIX = 'AAAAAgAAAAAMOCK_SIGNED_TX_';
export const DUMMY_SIGNED_AUTH_ENTRY_PREFIX = 'AAAAAgAAAAAMOCK_SIGNED_AUTH_';

export interface DummyWalletConfig {
  address?: string;
  walletId?: string;
  networkPassphrase?: string;
  autoApprove?: boolean;
  preConnected?: boolean;
  rejectionReason?: string;
}

export interface InjectedDummyWalletState {
  address: string;
  walletId: string;
  networkPassphrase: string;
  autoApprove: boolean;
  isConnected: boolean;
  rejectionReason: string | null;
  history: Array<{
    type: 'signTransaction' | 'signAuthEntry' | 'connect' | 'disconnect';
    payload: any;
    timestamp: number;
  }>;
}


export function createDummyWalletInitScript(config: DummyWalletConfig = {}): string {
  const address = config.address || DEFAULT_TEST_WALLET_ADDRESS;
  const walletId = config.walletId || DEFAULT_TEST_WALLET_ID;
  const passphrase = config.networkPassphrase || DEFAULT_NETWORK_PASSPHRASE;
  const autoApprove = config.autoApprove ?? true;
  const preConnected = config.preConnected ?? true;
  const rejectionReason = config.rejectionReason || 'User rejected transaction in wallet';

  return `
    (function() {
      // 1. Configure initial session storage if preConnected
      if (${preConnected}) {
        try {
          window.localStorage.setItem(
            '${SESSION_STORAGE_KEY}',
            JSON.stringify({
              address: '${address}',
              walletId: '${walletId}',
              passphrase: '${passphrase}',
              persistedAt: Date.now()
            })
          );
        } catch (e) {
          console.warn('[DummyWalletAdapter] Failed to set initial session in localStorage', e);
        }
      }

      // 2. Auto-accept window.confirm prompts (used by WalletProvider for intent checks)
      window.confirm = function(message) {
        const wallet = window.__EDUVAULT_DUMMY_WALLET__;
        if (wallet && !wallet.autoApprove) {
          return false;
        }
        return true;
      };

      // 3. Define and expose the global dummy wallet state & controller
      window.__EDUVAULT_DUMMY_WALLET__ = {
        address: '${address}',
        walletId: '${walletId}',
        networkPassphrase: '${passphrase}',
        autoApprove: ${autoApprove},
        isConnected: ${preConnected},
        rejectionReason: ${JSON.stringify(rejectionReason)},
        history: [],

        // State mutation methods accessible by tests via page.evaluate
        setAddress: function(newAddress) {
          this.address = newAddress;
          if (this.isConnected) {
            this.persistSession();
          }
        },

        setAutoApprove: function(approve) {
          this.autoApprove = approve;
        },

        setRejectionReason: function(reason) {
          this.rejectionReason = reason;
        },

        persistSession: function() {
          try {
            window.localStorage.setItem(
              '${SESSION_STORAGE_KEY}',
              JSON.stringify({
                address: this.address,
                walletId: this.walletId,
                passphrase: this.networkPassphrase,
                persistedAt: Date.now()
              })
            );
          } catch (e) {
            console.error('[DummyWalletAdapter] persistSession failed', e);
          }
        },

        clearSession: function() {
          try {
            window.localStorage.removeItem('${SESSION_STORAGE_KEY}');
          } catch (e) {
            console.error('[DummyWalletAdapter] clearSession failed', e);
          }
        },

        // Core adapter interface
        getAddress: async function() {
          if (!this.isConnected) {
            return { address: undefined };
          }
          return { address: this.address };
        },

        authModal: async function() {
          this.history.push({
            type: 'connect',
            payload: { address: this.address },
            timestamp: Date.now()
          });

          if (!this.autoApprove) {
            const err = new Error(this.rejectionReason || 'User dismissed wallet modal');
            err.dismissed = true;
            throw err;
          }

          this.isConnected = true;
          this.persistSession();
          return { address: this.address };
        },

        disconnect: async function() {
          this.history.push({
            type: 'disconnect',
            payload: {},
            timestamp: Date.now()
          });
          this.isConnected = false;
          this.clearSession();
          return true;
        },

        signTransaction: async function(xdr, opts) {
          this.history.push({
            type: 'signTransaction',
            payload: { xdr, opts },
            timestamp: Date.now()
          });

          if (!this.autoApprove) {
            const err = new Error(this.rejectionReason || 'Transaction cancelled before wallet signing');
            err.code = 'wallet_intent_rejected';
            err.dismissed = true;
            throw err;
          }

          // Return deterministic signed XDR
          const signedTxXdr = typeof xdr === 'string' && xdr.length > 0
            ? '${DUMMY_SIGNED_TX_XDR_PREFIX}' + btoa(xdr.slice(0, 16) + ':' + this.address)
            : '${DUMMY_SIGNED_TX_XDR_PREFIX}' + Date.now();

          return { signedTxXdr };
        },

        signAuthEntry: async function(entryXdr, opts) {
          this.history.push({
            type: 'signAuthEntry',
            payload: { entryXdr, opts },
            timestamp: Date.now()
          });

          if (!this.autoApprove) {
            const err = new Error(this.rejectionReason || 'Auth entry signing cancelled');
            err.dismissed = true;
            throw err;
          }

          const signedAuthEntry = typeof entryXdr === 'string' && entryXdr.length > 0
            ? '${DUMMY_SIGNED_AUTH_ENTRY_PREFIX}' + btoa(entryXdr.slice(0, 16) + ':' + this.address)
            : '${DUMMY_SIGNED_AUTH_ENTRY_PREFIX}' + Date.now();

          return { signedAuthEntry };
        },

        getHistory: function() {
          return this.history;
        }
      };

      // 4. Inject mock extension objects (Freighter, Albedo, xBull) to satisfy browser detection
      window.freighterApi = {
        isConnected: async () => true,
        isAllowed: async () => true,
        getPublicKey: async () => window.__EDUVAULT_DUMMY_WALLET__.address,
        getNetwork: async () => 'TESTNET',
        getNetworkDetails: async () => ({
          network: 'TESTNET',
          networkUrl: 'https://horizon-testnet.stellar.org',
          networkPassphrase: window.__EDUVAULT_DUMMY_WALLET__.networkPassphrase
        }),
        signTransaction: async (xdr, opts) => {
          const res = await window.__EDUVAULT_DUMMY_WALLET__.signTransaction(xdr, opts);
          return res.signedTxXdr;
        },
        signAuthEntry: async (entryXdr, opts) => {
          const res = await window.__EDUVAULT_DUMMY_WALLET__.signAuthEntry(entryXdr, opts);
          return res.signedAuthEntry;
        }
      };

      window.stellar = {
        freighter: window.freighterApi
      };
    })();
  `;
}
