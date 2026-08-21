const CLEANUP_OUTBOX = "file_cleanup_outbox";

export class StorageCleanupConflictError extends Error {
  constructor(storageKey) {
    super(`storage cleanup is already processing ${storageKey}`);
    this.name = "StorageCleanupConflictError";
    this.code = "STORAGE_CLEANUP_CONFLICT";
  }
}

function isDuplicateKey(error) {
  return error?.code === 11000 || error?.codeName === "DuplicateKey";
}

export async function acquireStorageClaim(db, storageKey, claimId, now = new Date()) {
  const outbox = db.collection(CLEANUP_OUTBOX);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await outbox.findOne({ storageKey });
    if (!existing) {
      try {
        await outbox.insertOne({
          storageKey,
          status: "claimed",
          claimId,
          claimedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        return;
      } catch (error) {
        if (isDuplicateKey(error)) continue;
        throw error;
      }
    }

    if (existing.status === "claimed" && existing.claimId === claimId) return;
    if (existing.status === "pending" && existing.reason === "orphan") {
      const result = await outbox.updateOne(
        { storageKey, status: "pending", reason: "orphan" },
        {
          $set: {
            status: "claimed",
            claimId,
            claimedAt: now,
            updatedAt: now,
          },
        },
      );
      if (result.matchedCount === 1) return;
      continue;
    }

    throw new StorageCleanupConflictError(storageKey);
  }

  throw new StorageCleanupConflictError(storageKey);
}

export async function releaseStorageClaim(db, storageKey, claimId) {
  await db.collection(CLEANUP_OUTBOX).deleteOne({
    storageKey,
    status: "claimed",
    claimId,
  });
}
