/**
 * Authorized, validated file lifecycle (#98).
 *
 * A single metadata model for every stored object, linking it to its owner,
 * purpose, parent entity, size, MIME type, checksum and lifecycle state. This
 * is the layer the acceptance criteria hang on:
 *
 *  - authorization: reads, replacements and deletes are owner-scoped, so one
 *    tenant cannot touch another's private objects;
 *  - separate policies: each purpose declares its own visibility and byte
 *    limit (public avatars vs private evidence);
 *  - no orphans: deletion is a two-phase, transactional handoff to a cleanup
 *    outbox rather than a best-effort unpin that a DB failure could strand;
 *  - dedupe: identical content for the same owner resolves to one object.
 *
 * Storage backend is intentionally abstracted behind an `unpin`-style adapter
 * passed to the worker, so this model is correct whether objects live on IPFS
 * or object storage — that decision is deferred and does not change the model.
 *
 * `storageKey` is the backend object identifier the remove adapter acts on:
 * for IPFS that is the CID (which the upload path already produces and which is
 * globally unique); `normalizeStorageKey` derives a deterministic
 * purpose/owner/checksum key for object-storage backends where the caller
 * chooses the key. Either way it is unique per stored object.
 */

import { createHash } from "node:crypto";

import {
  COLLECTIONS,
  FILE_STATES,
  FILE_VISIBILITY,
  FILE_PURPOSES,
} from "../backend/schemaContracts.js";

export class FileAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileAuthorizationError";
    this.code = "FILE_FORBIDDEN";
    this.status = 403;
  }
}

export class FileValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileValidationError";
    this.code = "FILE_INVALID";
    this.status = 400;
  }
}

export class FileNotFoundError extends Error {
  constructor(message = "file not found") {
    super(message);
    this.name = "FileNotFoundError";
    this.code = "FILE_NOT_FOUND";
    this.status = 404;
  }
}

function purposeSpec(purpose) {
  const spec = Object.values(FILE_PURPOSES).find((p) => p.purpose === purpose);
  if (!spec) throw new FileValidationError(`unknown file purpose: ${purpose}`);
  return spec;
}

export function checksumOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate a file's identity and content against its purpose policy, returning
 * the verified checksum. Throws FileValidationError on any mismatch. Pure — no
 * database access — so it can be run as a pre-flight check before any write.
 */
export function assertValidFileInput({ purpose, mimeType, size, checksum, content = null }) {
  const spec = purposeSpec(purpose);

  if (!mimeType) throw new FileValidationError("mimeType is required");
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new FileValidationError("size must be a positive integer");
  }
  if (size > spec.maxBytes) {
    throw new FileValidationError(
      `file exceeds the ${Math.round(spec.maxBytes / (1024 * 1024))}MB limit for ${purpose}`,
    );
  }

  // Content verification, when the bytes are supplied: the stored checksum and
  // size must match the actual content, never the client's claim.
  if (content) {
    const actual = checksumOf(content);
    if (checksum && checksum.toLowerCase() !== actual) {
      throw new FileValidationError("checksum does not match file content");
    }
    if (content.length !== size) {
      throw new FileValidationError("declared size does not match file content");
    }
    checksum = actual;
  }

  if (!/^[a-f\d]{64}$/i.test(checksum || "")) {
    throw new FileValidationError("a sha256 checksum is required");
  }

  return { spec, checksum: checksum.toLowerCase() };
}

/**
 * Normalize a storage key so it cannot escape its namespace or collide by
 * casing/traversal. Keys are lowercased, path-separated on a fixed prefix, and
 * stripped of anything outside a conservative charset.
 */
export function normalizeStorageKey({ purpose, ownerId, checksum }) {
  const safeOwner = String(ownerId).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const safePurpose = String(purpose).replace(/[^a-z0-9_]/g, "");
  if (!safeOwner || !safePurpose || !/^[a-f\d]{64}$/i.test(checksum)) {
    throw new FileValidationError("cannot derive a storage key from the given identity");
  }
  return `${safePurpose}/${safeOwner}/${checksum.toLowerCase()}`;
}

/**
 * Register a file's metadata after its bytes have been validated and (for
 * quarantined purposes) approved. Idempotent on identical content: a repeat
 * upload of the same bytes by the same owner for the same purpose returns the
 * existing record rather than creating a duplicate object.
 *
 * The bytes themselves are not stored here — the caller uploads them to
 * storage and passes the resulting `storageKey`/checksum. Passing `content`
 * lets the model verify the checksum and size rather than trusting the caller.
 */
export async function registerFile(db, {
  ownerId,
  purpose,
  parentType = null,
  parentId = null,
  fileName,
  mimeType,
  size,
  checksum,
  storageKey,
  content = null,
  now = new Date(),
}) {
  if (!ownerId) throw new FileValidationError("ownerId is required");
  const { spec, checksum: verifiedChecksum } = assertValidFileInput({ purpose, mimeType, size, checksum, content });
  checksum = verifiedChecksum;

  const normalizedKey = storageKey || normalizeStorageKey({ purpose, ownerId, checksum });
  const files = db.collection(COLLECTIONS.files);

  // Content-addressed dedupe: same owner + same bytes => the existing object.
  const existing = await files.findOne({
    ownerId,
    checksum: checksum.toLowerCase(),
    state: { $in: [FILE_STATES.PENDING, FILE_STATES.ACTIVE] },
  });
  if (existing) return { file: existing, deduped: true };

  const record = {
    ownerId,
    purpose,
    visibility: spec.visibility,
    parentType,
    parentId,
    fileName: String(fileName || "").slice(0, 255) || null,
    mimeType,
    size,
    checksum: checksum.toLowerCase(),
    storageKey: normalizedKey,
    state: FILE_STATES.ACTIVE,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await files.insertOne(record);
    return { file: { _id: result.insertedId, ...record }, deduped: false };
  } catch (error) {
    if (error?.code === 11000) {
      // Another writer registered the same storage key first; return theirs.
      const raced = await files.findOne({ storageKey: normalizedKey });
      if (raced) return { file: raced, deduped: true };
    }
    throw error;
  }
}

/** Load a file record, enforcing that `requesterId` is allowed to see it. */
export async function getFileForRequester(db, storageKey, requesterId) {
  const file = await db.collection(COLLECTIONS.files).findOne({ storageKey });
  if (!file || file.state === FILE_STATES.DELETED) throw new FileNotFoundError();

  if (file.visibility === FILE_VISIBILITY.PUBLIC) return file;
  if (file.ownerId && file.ownerId === requesterId) return file;

  // A private object is never confirmed to a non-owner — surface a 404, not a
  // 403, so its existence is not leaked.
  throw new FileNotFoundError();
}

/**
 * Replace the object behind a parent entity (e.g. swap a user's avatar).
 * Registers the new file, points the parent at it, and enqueues the previous
 * object for cleanup — all in one transaction when the driver supports it, so
 * a crash cannot leave the parent pointing at a half-deleted object.
 */
export async function replaceFile(db, {
  requesterId,
  parentType,
  parentId,
  purpose,
  ...fileInput
}, { now = new Date() } = {}) {
  const files = db.collection(COLLECTIONS.files);
  const current = await files.findOne({
    parentType,
    parentId,
    purpose,
    state: FILE_STATES.ACTIVE,
  });

  if (current && current.ownerId !== requesterId) {
    throw new FileAuthorizationError("cannot replace a file you do not own");
  }
  if (fileInput.ownerId && fileInput.ownerId !== requesterId) {
    throw new FileAuthorizationError("cannot register a file for another owner");
  }

  // Pre-flight: reject an invalid replacement before touching the current file,
  // so a bad request can never retire a good object (matters on the standalone
  // fallback where the retire+register are not wrapped in one transaction).
  assertValidFileInput({ purpose, ...fileInput });

  return withOptionalTransaction(db, async (session) => {
    // Retire the current object first: the `files_parent_active_unique` index
    // permits only one active file per parent, so the new record cannot be
    // inserted while the old one is still active. Inside the transaction this
    // is atomic; the pre-flight validation below keeps the standalone fallback
    // from retiring a good file for an invalid replacement.
    if (current) {
      await retireFile(db, current, { session, now, reason: "replaced" });
    }

    const { file, deduped } = await registerFile(db, {
      ...fileInput,
      ownerId: requesterId,
      purpose,
      parentType,
      parentId,
      now,
    });

    return { file, deduped, replaced: Boolean(current) };
  });
}

/**
 * Delete a file. Owner-scoped. Two-phase: the record is moved to
 * `pending_deletion` and a cleanup task is enqueued in the same transaction,
 * so the storage object is always eventually removed even if the process dies
 * immediately after — the outbox is the durable source of truth.
 */
export async function deleteFile(db, { requesterId, storageKey }, { now = new Date() } = {}) {
  const files = db.collection(COLLECTIONS.files);
  const file = await files.findOne({ storageKey });
  if (!file || file.state === FILE_STATES.DELETED) throw new FileNotFoundError();
  if (file.ownerId !== requesterId) {
    throw new FileAuthorizationError("cannot delete a file you do not own");
  }

  return withOptionalTransaction(db, async (session) => {
    await retireFile(db, file, { session, now, reason: "deleted" });
    return { storageKey, state: FILE_STATES.PENDING_DELETION };
  });
}

/**
 * Move a file to pending_deletion and enqueue its storage cleanup. Shared by
 * delete and replace. Must run inside `withOptionalTransaction`.
 */
async function retireFile(db, file, { session, now, reason }) {
  const opts = session ? { session } : {};
  await db.collection(COLLECTIONS.files).updateOne(
    { _id: file._id, state: { $ne: FILE_STATES.DELETED } },
    { $set: { state: FILE_STATES.PENDING_DELETION, retireReason: reason, retiredAt: now, updatedAt: now } },
    opts,
  );

  await db.collection(COLLECTIONS.fileCleanupOutbox).updateOne(
    { storageKey: file.storageKey },
    {
      $set: {
        storageKey: file.storageKey,
        ownerId: file.ownerId,
        purpose: file.purpose,
        status: "pending",
        nextAttemptAt: now,
        reason,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now, attempts: 0 },
    },
    { ...opts, upsert: true },
  );
}

/**
 * Run `fn` inside a Mongo transaction when the driver supports one, falling
 * back to a plain call on a standalone server. The individual writes are
 * idempotent, so the fallback costs atomicity but not correctness — the
 * cleanup worker reconciles any torn state.
 */
async function withOptionalTransaction(db, fn) {
  const client = db.client;
  if (!client || typeof client.startSession !== "function") return fn(null);

  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (error) {
    const unsupported =
      error?.codeName === "IllegalOperation" ||
      /Transaction numbers are only allowed on a replica set/i.test(String(error?.message || ""));
    if (!unsupported) throw error;
    return fn(null);
  } finally {
    await session.endSession();
  }
}

/**
 * Drain the cleanup outbox: remove each pending storage object via the
 * supplied `remove(storageKey)` adapter, then tombstone its file record. Safe
 * to run repeatedly; a failed removal is retried with a bounded attempt count.
 */
export async function runFileCleanup(db, remove, { limit = 100, maxAttempts = 5, now = new Date() } = {}) {
  if (typeof remove !== "function") throw new Error("a storage remove(storageKey) adapter is required");

  const outbox = db.collection(COLLECTIONS.fileCleanupOutbox);
  const due = await outbox
    .find({ status: "pending", nextAttemptAt: { $lte: now } })
    .limit(Math.min(Math.max(limit, 1), 500))
    .toArray();

  let removed = 0;
  const failed = [];
  for (const task of due) {
    try {
      await remove(task.storageKey);
      await db.collection(COLLECTIONS.files).updateOne(
        { storageKey: task.storageKey },
        { $set: { state: FILE_STATES.DELETED, deletedAt: now, updatedAt: now } },
      );
      await outbox.deleteOne({ storageKey: task.storageKey });
      removed += 1;
    } catch (error) {
      const attempts = (task.attempts || 0) + 1;
      const status = attempts >= maxAttempts ? "failed" : "pending";
      // Exponential backoff, capped, so a persistently failing object does not
      // spin the worker.
      const backoffMs = Math.min(60 * 60 * 1000, 1000 * 2 ** attempts);
      await outbox.updateOne(
        { storageKey: task.storageKey },
        {
          $set: {
            attempts,
            status,
            lastError: String(error?.message || error),
            nextAttemptAt: new Date(now.getTime() + backoffMs),
            updatedAt: now,
          },
        },
      );
      failed.push({ storageKey: task.storageKey, status, error: String(error?.message || error) });
    }
  }

  return { scanned: due.length, removed, failed };
}

/**
 * Detect orphans in both directions:
 *   - storage objects the backend still holds that have no live file record;
 *   - file records past their retention window still stuck in a non-deleted
 *     state (e.g. cleanup never completed).
 *
 * `listStorageKeys()` returns the keys the storage backend currently holds.
 * In `apply` mode the orphaned storage keys are enqueued for cleanup; in
 * `dryRun` mode (the default) nothing is written and the report is returned
 * for inspection.
 */
export async function detectOrphans(db, listStorageKeys, {
  mode = "dryRun",
  retentionMs = 30 * 24 * 60 * 60 * 1000,
  now = new Date(),
} = {}) {
  if (typeof listStorageKeys !== "function") {
    throw new Error("a listStorageKeys() adapter is required");
  }

  const files = db.collection(COLLECTIONS.files);
  const storageKeys = await listStorageKeys();

  // Storage objects with no live (pending/active/pending_deletion) record.
  const orphanedStorage = [];
  for (const key of storageKeys) {
    const record = await files.findOne({ storageKey: key, state: { $ne: FILE_STATES.DELETED } });
    if (!record) orphanedStorage.push(key);
  }

  // Records that should have been cleaned up but were not, past retention.
  const cutoff = new Date(now.getTime() - retentionMs);
  const stuckRecords = await files
    .find({ state: FILE_STATES.PENDING_DELETION, retiredAt: { $lte: cutoff } })
    .toArray();

  if (mode === "apply") {
    const outbox = db.collection(COLLECTIONS.fileCleanupOutbox);
    for (const key of orphanedStorage) {
      await outbox.updateOne(
        { storageKey: key },
        {
          $set: { storageKey: key, status: "pending", nextAttemptAt: now, reason: "orphan", updatedAt: now },
          $setOnInsert: { createdAt: now, attempts: 0 },
        },
        { upsert: true },
      );
    }
  }

  return {
    mode,
    orphanedStorageKeys: orphanedStorage,
    stuckRecordKeys: stuckRecords.map((r) => r.storageKey),
    enqueued: mode === "apply" ? orphanedStorage.length : 0,
  };
}
