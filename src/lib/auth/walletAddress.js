import { Address } from "@stellar/stellar-sdk";

export function normalizeWalletAddress(value) {
  const address = String(value || "").trim();
  if (!address) return null;
  try {
    Address.fromString(address);
    return address.toLowerCase();
  } catch {
    return null;
  }
}
