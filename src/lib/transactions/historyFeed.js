const DEFAULT_CACHE_TTL_MS = 60_000;
const HORIZON_BASE_URL =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";

function getCacheStore() {
  if (!globalThis.__eduvaultHistoryCache) {
    globalThis.__eduvaultHistoryCache = new Map();
  }
  return globalThis.__eduvaultHistoryCache;
}

function readCache(key, now = Date.now()) {
  const cache = getCacheStore();
  const record = cache.get(key);
  if (!record) return null;
  if (record.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return record.value;
}

function writeCache(key, value, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now()) {
  getCacheStore().set(key, { value, expiresAt: now + ttlMs });
}

function normalizeOnchainTransaction(tx) {
  return {
    id: tx.id || tx.hash,
    hash: tx.hash,
    sourceAccount: tx.source_account,
    ledger: tx.ledger_attr || tx.ledger || null,
    successful: tx.successful,
    createdAt: tx.created_at,
    operationCount: tx.operation_count ?? null,
    feeCharged: tx.fee_charged ?? null,
    memoType: tx.memo_type ?? null,
    memo: tx.memo ?? null,
    type: "onchain_transaction",
  };
}

export async function fetchHorizonTransactions(address, { page = 1, limit = 20 } = {}) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
  const cacheKey = `${address}:${safePage}:${safeLimit}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const horizonLimit = safePage * safeLimit;
  const url = `${HORIZON_BASE_URL}/accounts/${encodeURIComponent(address)}/transactions?order=desc&limit=${horizonLimit}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Horizon request failed (${response.status})`);
  }

  const payload = await response.json();
  const allRecords = payload?._embedded?.records || [];
  const start = (safePage - 1) * safeLimit;
  const paginated = allRecords.slice(start, start + safeLimit).map(normalizeOnchainTransaction);
  const result = {
    records: paginated,
    hasMore: allRecords.length > start + safeLimit,
  };
  writeCache(cacheKey, result);
  return result;
}

export function buildPurchaseHistoryRecords(purchases) {
  return purchases.map((purchase) => ({
    id: String(purchase._id),
    hash: purchase.transactionHash || purchase.chainTxHash || null,
    materialId: purchase.materialId || null,
    status: purchase.status || null,
    amount: purchase.amount ?? null,
    asset: purchase.asset ?? null,
    source: "database",
    createdAt: purchase.purchasedAt || purchase.updatedAt || purchase.createdAt || null,
    type: "purchase_record",
  }));
}
