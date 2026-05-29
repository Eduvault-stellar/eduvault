import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit';
import { defaultModules } from '@creit-tech/stellar-wallets-kit/modules/utils';
import { Horizon } from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, HORIZON_URL } from '@/lib/config/chain';

export const horizon = new Horizon.Server(HORIZON_URL);

let initialized = false;

export function ensureKitInitialized() {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: defaultModules(),
    network: NETWORK_PASSPHRASE,
  });
  initialized = true;
}

export { StellarWalletsKit };
export { NETWORK_PASSPHRASE };
