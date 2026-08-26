import { Networks } from '@stellar/stellar-sdk';

/**
 * Single validated source of truth for "is this deployment on Stellar
 * mainnet" (issue #137). Every other module that needs a network-dependent
 * endpoint or passphrase must import it from here rather than re-deriving
 * its own check against `NEXT_PUBLIC_STELLAR_NETWORK` -- historically
 * `refundService.js` compared against lowercase `'mainnet'` while this file
 * and `historyFeed.js` compared against uppercase `'PUBLIC'`, so a single
 * env value could be interpreted as mainnet by one module and testnet by
 * another, letting a mainnet transaction be *signed* with the wrong network
 * passphrase while being *submitted* to the right (or wrong) Horizon
 * endpoint. Since a Stellar transaction's signature is computed over a hash
 * that includes the network passphrase (see Stellar's Network Passphrases
 * docs: the passphrase is SHA-256'd into the network ID used in the
 * signature base, specifically so a transaction signed for one network
 * cannot be replayed on another), a passphrase/endpoint mismatch does not
 * degrade gracefully -- Horizon rejects the transaction outright.
 *
 * Accepts the two conventions already in use across this codebase
 * (`'mainnet'` and `'PUBLIC'`, matched case-insensitively) plus `'testnet'`,
 * so no existing deployment's `.env` value stops working. An unset value
 * keeps defaulting to testnet, unchanged from prior behavior. Any other,
 * unrecognized value fails loudly at startup instead of silently
 * misinterpreting a likely typo as testnet.
 */
const MAINNET_ALIASES = new Set(['mainnet', 'public']);
const TESTNET_ALIASES = new Set(['testnet']);

function resolveIsMainnet(rawValue) {
  if (rawValue == null || rawValue === '') return false;

  const normalized = rawValue.trim().toLowerCase();
  if (MAINNET_ALIASES.has(normalized)) return true;
  if (TESTNET_ALIASES.has(normalized)) return false;

  throw new Error(
    `Invalid NEXT_PUBLIC_STELLAR_NETWORK "${rawValue}": expected "mainnet", "public", ` +
      `or "testnet" (case-insensitive).`,
  );
}

const IS_MAINNET = resolveIsMainnet(process.env.NEXT_PUBLIC_STELLAR_NETWORK);

export const NETWORK_PASSPHRASE = IS_MAINNET ? Networks.PUBLIC : Networks.TESTNET;

export const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL || process.env.STELLAR_RPC_URL ||
  'https://soroban-testnet.stellar.org';

export const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ||
  (IS_MAINNET
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org');

export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ||
  (IS_MAINNET
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

export const isMainnet = IS_MAINNET;

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
