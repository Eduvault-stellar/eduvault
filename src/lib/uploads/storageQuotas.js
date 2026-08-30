/**
 * Per-owner storage quota reservations (#148).
 *
 * Upload sessions accept files up to 5GB (see uploadSessions.js) but nothing
 * previously tracked how much capacity an owner had reserved across their
 * concurrent sessions, so N sessions created back-to-back could each pass
 * validation and collectively reserve far more storage than the owner is
 * entitled to. This module gives each owner one document that atomically
 * accounts for bytes currently reserved by in-flight/completed sessions,
 * using a conditional `$inc` so concurrent reservations can never push the
 * total past the owner's quota, and a bounded retry loop (mirroring
 * storageClaims.js) so a race to create the first reservation document for
 * an owner cannot fail spuriously on a duplicate-key error.
 */

const OWNER_STORAGE_QUOTAS = "owner_storage_quotas";

// 50 GiB per owner by default. Override with UPLOAD_OWNER_STORAGE_QUOTA_BYTES.
export const DEFAULT_OWNER_STORAGE_QUOTA_BYTES = (() => {
  const configured = Number(process.env.UPLOAD_OWNER_STORAGE_QUOTA_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 50 * 1024 * 1024 * 1024;
})();

export class StorageQuotaExceededError extends Error {
  constructor(ownerId, requestedBytes, availableBytes) {
    super(`storage quota exceeded: requested ${requestedBytes} bytes, ${Math.max(0, availableBytes)} available`);
    this.name = "StorageQuotaExceededError";
    this.code = "STORAGE_QUOTA_EXCEEDED";
    this.status = 413;
  }
}

function isDuplicateKey(error) {
  return error?.code === 11000 || error?.codeName === "DuplicateKey";
}

export async function ensureOwnerQuotaIndexes(db) {
  await db.collection(OWNER_STORAGE_QUOTAS).createIndex({ ownerId: 1 }, { unique: true });
}

/**
 * Atomically reserve `bytes` of an owner's storage quota. Succeeds only if
 * the owner's existing reservation plus `bytes` does not exceed `quotaBytes`.
 * Throws StorageQuotaExceededError otherwise.
 *
 * Two writers reserving for the same owner at once cannot both observe "room
 * available" and jointly overshoot the quota: the increment and the quota
 * check happen in one `updateOne` with an `$expr` filter, so only one of two
 * conflicting increments can match. Deliberately avoids combining that
 * `$expr` filter with `upsert: true` — an upsert whose filter fails only
 * because the owner is over quota would otherwise attempt to *insert* a
 * second document and fail on the unique `ownerId` index instead of
 * reporting the quota error. Creating the owner's first reservation document
 * is therefore a separate, explicitly-guarded insert with its own retry on a
 * duplicate-key race (mirrors storageClaims.js's acquireStorageClaim).
 */
export async function reserveOwnerStorage(db, { ownerId, bytes, quotaBytes = DEFAULT_OWNER_STORAGE_QUOTA_BYTES, now = new Date() }) {
  if (!ownerId) throw new Error("ownerId is required")
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("bytes must be a positive integer")
  const quotas = db.collection(OWNER_STORAGE_QUOTAS)

  if (bytes > quotaBytes) throw new StorageQuotaExceededError(ownerId, bytes, quotaBytes)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await quotas.updateOne(
      { ownerId, $expr: { $lte: [{ $add: [{ $ifNull: ["$reservedBytes", 0] }, bytes] }, quotaBytes] } },
      { $inc: { reservedBytes: bytes }, $set: { updatedAt: now } }
    )
    if (updated.matchedCount === 1) return quotas.findOne({ ownerId })

    const existing = await quotas.findOne({ ownerId })
    if (existing) {
      throw new StorageQuotaExceededError(ownerId, bytes, quotaBytes - (existing.reservedBytes || 0))
    }

    try {
      await quotas.insertOne({ ownerId, reservedBytes: bytes, createdAt: now, updatedAt: now })
      return quotas.findOne({ ownerId })
    } catch (error) {
      if (isDuplicateKey(error)) continue // another writer created the doc first; retry the conditional update
      throw error
    }
  }
  throw new StorageQuotaExceededError(ownerId, bytes, quotaBytes)
}

/**
 * Release a previously reserved amount back to the owner's available quota.
 * Idempotent no-op when there is nothing left to release (e.g. a duplicate
 * or out-of-order call), so it never drives a reservation negative.
 */
export async function releaseOwnerStorage(db, { ownerId, bytes, now = new Date() }) {
  if (!ownerId || !Number.isSafeInteger(bytes) || bytes < 1) return
  await db.collection(OWNER_STORAGE_QUOTAS).updateOne(
    { ownerId, reservedBytes: { $gte: bytes } },
    { $inc: { reservedBytes: -bytes }, $set: { updatedAt: now } }
  )
}
