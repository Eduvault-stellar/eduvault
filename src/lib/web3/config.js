import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { walletConnect, injected, coinbaseWallet } from 'wagmi/connectors';

// ── WalletConnect is optional. ─────────────────────────────────────────────────
// Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in your environment to enable it.
// Leaving the variable unset (or keeping the placeholder) disables WalletConnect
// so that next build does NOT trigger a remote Reown/Web3Modal config fetch.
// See .env.example for details.
const _rawProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';
const PLACEHOLDER = 'YOUR_PROJECT_ID';

/**
 * True only when a real WalletConnect project ID has been configured.
 * Exported so tests can assert on the resolved connector list.
 */
export const walletConnectEnabled =
  _rawProjectId.length > 0 && _rawProjectId !== PLACEHOLDER;

// Define supported chains
export const chains = [mainnet, sepolia];

// Build connector list — WalletConnect is omitted when no real project ID exists.
const connectors = [
  // Injected connector (MetaMask, browser wallets)
  injected({
    shimDisconnect: true,
  }),
  // Coinbase Wallet — always available regardless of WalletConnect status
  coinbaseWallet({
    appName: 'EduVault',
    appLogoUrl: 'https://eduvault.com/icon.png',
  }),
];

if (walletConnectEnabled) {
  connectors.push(
    walletConnect({
      projectId: _rawProjectId,
      metadata: {
        name: 'EduVault',
        description: 'Decentralized Educational Materials Sharing Platform',
        url: typeof window !== 'undefined' ? window.location.origin : '',
        icons: ['https://eduvault.com/icon.png'],
      },
      showQrModal: true,
    })
  );
}

// Configure wagmi
export const config = createConfig({
  chains: [mainnet, sepolia],
  connectors,
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});
