import { HORIZON_URL } from "@/lib/config/chain";

const DEFAULT_CACHE_TTL_MS = 60_000;

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

// Horizon transaction paging tokens are decimal strings (ledger operation
// sequence markers). Anything else is rejected before it can reach Horizon.
export function isValidHorizonCursor(cursor) {
  return typeof cursor === "string" && /^\d{1,32}$/.test(cursor);
}

function normalizeOnchainTransaction(tx) {
  return {
    id: tx.id || tx.hash,
    hash: tx.hash,
    pagingToken: tx.paging_token ?? null,
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

/**
 * Fetches one bounded page of an account's Horizon transactions.
 *
 * Pagination is cursor-based: pass the `nextCursor` from a previous result to
 * fetch the next older page. Each call requests exactly `limit` records from
 * Horizon regardless of page depth — no expanding page*limit fetches.
 */
export async function fetchHorizonTransactions(address, { limit = 20, cursor = null } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;

  let safeCursor = null;
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    safeCursor = String(cursor);
    if (!isValidHorizonCursor(safeCursor)) {
      throw new Error("Invalid Horizon paging token cursor");
    }
  }

  const cacheKey = `${address}:${safeCursor ?? ""}:${safeLimit}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ order: "desc", limit: String(safeLimit) });
  if (safeCursor) params.set("cursor", safeCursor);
  const url = `${HORIZON_BASE_URL}/accounts/${encodeURIComponent(address)}/transactions?${params.toString()}`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Horizon request failed (${response.status})`);
  }

  const payload = await response.json();
  const records = (payload?._embedded?.records || []).map(normalizeOnchainTransaction);
  // Only advertise continuation when this page was full and Horizon still has
  // a next link; short or empty pages end the feed so stale cursors cannot
  // loop pagination forever.
  const result = {
    records,
    hasMore: records.length >= safeLimit && Boolean(payload?._links?.next?.href),
    nextCursor: records.length ? records[records.length - 1].pagingToken : null,
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
