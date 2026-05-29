import { Networks } from '@stellar/stellar-sdk';

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'TESTNET';
export const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;

export const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL || process.env.STELLAR_RPC_URL ||
  'https://soroban-testnet.stellar.org';

export const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ||
  (STELLAR_NETWORK === 'PUBLIC'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ||
  (STELLAR_NETWORK === 'PUBLIC'
    ? 'https://stellar.expert/explorer/public'
    : 'https://stellar.expert/explorer/testnet');

export const MATERIAL_REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID ?? '';

export const PURCHASE_MANAGER_CONTRACT_ID =
  process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID ?? '';

export const SOROBAN_CONTRACT_ID =
  process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID ?? '';

export const ACCEPTED_ASSET = process.env.NEXT_PUBLIC_ACCEPTED_ASSET ?? 'USDC';

export const NATIVE_ASSET = 'XLM';

export const IPFS_GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL || 'https://gateway.pinata.cloud';

export const isMainnet = STELLAR_NETWORK === 'PUBLIC';

export function getExplorerTxUrl(txHash) {
  return `${EXPLORER_URL}/tx/${txHash}`;
}

export function getExplorerAccountUrl(address) {
  return `${EXPLORER_URL}/account/${address}`;
}

export function getIpfsUrl(cid) {
  if (!cid) return '';
  if (cid.startsWith('http')) return cid;
  return `${IPFS_GATEWAY_URL}/ipfs/${cid}`;
}
