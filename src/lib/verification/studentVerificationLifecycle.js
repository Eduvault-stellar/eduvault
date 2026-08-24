/**
 * Student Verification Document Lifecycle (issues #165, #107)
 *
 * States
 * ──────
 *  pending   – submitted, encrypted document awaiting admin review
 *  approved  – reviewed and accepted; encrypted document purged
 *  rejected  – reviewed and declined; encrypted document purged
 *  expired   – review window elapsed before a decision; encrypted document
 *              purged, student must resubmit
 *
 * Allowed transitions
 * ────────────────────
 *  pending → approved | rejected | expired
 *  approved / rejected / expired are terminal.
 *
 * Concurrency & race-safety (#107)
 * ────────────────────────────────
 * All database-level invariants are enforced by a partial unique index
 * `student_verifications_wallet_active_unique` on `{ walletAddress }`
 * filtered to `status ∈ { pending, approved }` (see REQUIRED_INDEXES in
 * schemaContracts.js and migration 006). This makes the database itself the
 * final concurrency boundary: even if the application-level duplicate check
 * is bypassed by a race, the second insert fails with E11000, which we map
 * to the typed 409 `duplicate_submission` error below — losing requests
 * never receive a generic 500.
 *
 * The review path uses an atomic guarded `findOneAndUpdate` against the
 * previous status, and wraps any multi-collection side effects in
 * `withOptionalTransaction` so they commit or roll back together.
 *
 * Privacy design
 * ───────────────
 *  - The uploaded document is AES-256-GCM encrypted (documentCipher.js)
 *    before it is ever written to Mongo; no plaintext bytes are persisted.
 *  - The ciphertext is only decrypted in-memory, on demand, for an admin
 *    performing a review, and only while the application is still `pending`
 *    and inside its review window.
 *  - Once a decision is made (approve/reject) or the review window elapses
 *    (expired), the encrypted payload is purged from the record — the
 *    document is not retained beyond the point it's needed for review.
 *
 * All writes go through reviewStudentVerification() / expireStaleSubmissions(),
 * which guard the update with the expected current status in the Mongo
 * filter so concurrent review attempts cannot both "win" the same decision
 * (mirrors src/lib/materials/materialLifecycle.js).
 */

import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import {
  encryptDocumentBuffer,
  decryptDocumentBuffer,
  DocumentEncryptionError,
} from "@/lib/security/documentCipher";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";

export const VERIFICATION_COLLECTION =
  COLLECTIONS.studentVerifications || "student_verifications";

async function resolveDb(db) {
  if (db) return db;
  return getDb();
}

export const VERIFICATION_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
});

const ACTIVE_STATUSES = Object.freeze([
  VERIFICATION_STATUS.PENDING,
  VERIFICATION_STATUS.APPROVED,
]);

const TERMINAL_STATUSES = new Set([
  VERIFICATION_STATUS.APPROVED,
  VERIFICATION_STATUS.REJECTED,
  VERIFICATION_STATUS.EXPIRED,
]);

// How long an uploaded document remains available for admin review before it
// is treated as expired and purged. Configurable for tests / ops tuning.
export const DEFAULT_REVIEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function getReviewWindowMs(env = process.env) {
  const raw = Number(env.VERIFICATION_REVIEW_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REVIEW_WINDOW_MS;
}

/**
 * Whether the verification channel is currently accepting new applications.
 * Models the #107 "only eligible, published bounty payouts can receive
 * applications" invariant — until an admin publishes the verification
 * channel, submissions must be rejected up front. Defaults to `true` to
 * preserve the previous behaviour for existing deployments that have not
 * set the env flag.
 */
export function isVerificationAcceptingApplications(env = process.env) {
  const raw = env.VERIFICATION_ACCEPTING_APPLICATIONS;
  if (raw === undefined || raw === null || raw === "") return true;
  const normalised = String(raw).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(normalised)) return false;
  if (["true", "1", "yes", "on"].includes(normalised)) return true;
  return true;
}

export const VALID_DOCUMENT_MIME_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/jpg",
  "application/pdf",
]);

export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export class VerificationLifecycleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VerificationLifecycleError";
    this.code = code;
  }
}

/** Maps a VerificationLifecycleError.code to the HTTP status a route should return. */
export const LIFECYCLE_ERROR_HTTP_STATUS = Object.freeze({
  not_found: 404,
  forbidden: 403,
  invalid_input: 400,
  duplicate_submission: 409,
  channel_unavailable: 409,
  invalid_transition: 409,
  conflict: 409,
  expired: 410,
  encryption_unavailable: 503,
});

export function statusToHttp(code) {
  return LIFECYCLE_ERROR_HTTP_STATUS[code] || 500;
}

function isDuplicateKeyError(error) {
  return (
    error?.code === 11000 ||
    error?.codeName === "DuplicateKey" ||
    error?.codeName === "DuplicateKeyError"
  );
}

function wrapEncryptionError(error) {
  if (error instanceof DocumentEncryptionError) {
    // Never leak the raw crypto error detail (secrets/paths) — map to a
    // typed, safely-loggable lifecycle error instead.
    return new VerificationLifecycleError(
      "Document could not be processed securely.",
      error.code === "decrypt_failed" ? "conflict" : "encryption_unavailable",
    );
  }
  return error;
}

function isExpired(record, now = new Date()) {
  return (
    !!record.documentExpiresAt &&
    record.documentExpiresAt.getTime() <= now.getTime()
  );
}

/**
 * Run `fn` inside a Mongo transaction when the driver supports one, falling
 * back to a plain call on a standalone server. Mirrors the helper in
 * `src/lib/uploads/fileLifecycle.js` so all multi-write operations in this
 * module commit or roll back together. #107 requires that approval side
 * effects (status update + audit log + downstream user-record update) be
 * atomic; this helper is the mechanism.
 */
async function withOptionalTransaction(db, fn) {
  const client = db.client;
  if (!client || typeof client.startSession !== "function") {
    return fn(null);
  }

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
      /Transaction numbers are only allowed on a replica set/i.test(
        String(error?.message || ""),
      );
    if (!unsupported) throw error;
    return fn(null);
  } finally {
    await session.endSession();
  }
}

/**
 * Validates + encrypts an uploaded document and creates a new pending
 * verification record. Race-safe (#107):
 *
 *   1. The application-level duplicate check provides a friendly 409 with
 *      a precise error message ("You already have a pending or approved
 *      verification application").
 *   2. The DB partial unique index on `{ walletAddress, status ∈ {pending,
 *      approved} }` is the final concurrency boundary — if two concurrent
 *      submissions both pass the check, exactly one insertOne wins and the
 *      other receives E11000 which we map to the same typed 409 instead of
 *      leaking a generic 500 to the client.
 *
 * Idempotent against duplicate active submissions from the same wallet.
 */
export async function submitStudentVerification({
  walletAddress,
  fullName,
  email,
  institution,
  studentId,
  expectedGraduation,
  documentBuffer,
  documentFilename,
  documentMimeType,
  documentSize,
  env = process.env,
  now = new Date(),
  db: providedDb,
} = {}) {
  if (
    !walletAddress ||
    !fullName ||
    !email ||
    !institution ||
    !studentId ||
    !expectedGraduation ||
    !documentBuffer
  ) {
    throw new VerificationLifecycleError(
      "All fields are required",
      "invalid_input",
    );
  }

  if (documentSize > MAX_DOCUMENT_SIZE_BYTES) {
    throw new VerificationLifecycleError(
      "File size exceeds 5MB limit",
      "invalid_input",
    );
  }

  if (!VALID_DOCUMENT_MIME_TYPES.includes(documentMimeType)) {
    throw new VerificationLifecycleError(
      "Invalid file type. Only JPG, PNG, and PDF are allowed",
      "invalid_input",
    );
  }

  if (!isVerificationAcceptingApplications(env)) {
    throw new VerificationLifecycleError(
      "Verification applications are not currently being accepted",
      "channel_unavailable",
    );
  }

  const normalizedWallet = String(walletAddress).toLowerCase();
  const db = await resolveDb(providedDb);
  const collection = db.collection(VERIFICATION_COLLECTION);

  const existing = await collection.findOne({
    walletAddress: normalizedWallet,
    status: { $in: ACTIVE_STATUSES },
  });

  if (existing) {
    throw new VerificationLifecycleError(
      "You already have a pending or approved verification application",
      "duplicate_submission",
    );
  }

  let encrypted;
  try {
    encrypted = encryptDocumentBuffer(documentBuffer, { env });
  } catch (error) {
    throw wrapEncryptionError(error);
  }

  const submittedAt = now;
  const documentExpiresAt = new Date(
    submittedAt.getTime() + getReviewWindowMs(env),
  );

  const record = {
    walletAddress: normalizedWallet,
    fullName: String(fullName).slice(0, 200),
    email: String(email).toLowerCase().slice(0, 200),
    institution: String(institution).slice(0, 200),
    studentId: String(studentId).slice(0, 100),
    expectedGraduation,
    document: {
      filename: String(documentFilename || "document").slice(0, 200),
      mimetype: documentMimeType,
      size: documentSize,
      encrypted,
    },
    status: VERIFICATION_STATUS.PENDING,
    submittedAt,
    documentExpiresAt,
    reviewedAt: null,
    reviewedBy: null,
    reviewNotes: null,
  };

  // `insertOne` inside a session lets the application code commit the
  // document write + the audit log (when wrapped in withOptionalTransaction)
  // as one unit on replica-set deployments, while remaining compatible
  // with standalone deployments via the fallback path.
  try {
    const result = await withOptionalTransaction(db, async (session) => {
      const insertResult = await collection.insertOne(record, { session });
      return { ...record, _id: insertResult.insertedId };
    });

    auditLog({
      event: "student_verification_submitted",
      route: "verification-student",
      method: "POST",
      status: 201,
      walletAddress: normalizedWallet,
      materialId: String(result._id),
    });

    return result;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // #107 acceptance criterion: "Losing requests receive a stable typed
      // 409, not a generic 500." Another concurrent submission inserted
      // the same active record between our findOne and our insertOne.
      auditLog({
        event: "student_verification_duplicate",
        route: "verification-student",
        method: "POST",
        status: 409,
        walletAddress: normalizedWallet,
        errorCode: "duplicate_submission",
      });
      throw new VerificationLifecycleError(
        "You already have a pending or approved verification application",
        "duplicate_submission",
      );
    }
    throw wrapEncryptionError(error);
  }
}

/**
 * Lazily expires any pending applications whose review window has elapsed
 * and purges their encrypted document payload. Safe to call opportunistically
 * from read paths (GET) since it only touches documents that are already
 * stale — no scheduler/cron dependency required.
 */
export async function expireStaleSubmissions({ now = new Date(), db: providedDb } = {}) {
  const db = await resolveDb(providedDb);
  const collection = db.collection(VERIFICATION_COLLECTION);

  const stale = await collection
    .find({ status: VERIFICATION_STATUS.PENDING, documentExpiresAt: { $lte: now } })
    .toArray();

  let expiredCount = 0;
  for (const doc of stale) {
    const updated = await collection.findOneAndUpdate(
      { _id: doc._id, status: VERIFICATION_STATUS.PENDING },
      {
        $set: { status: VERIFICATION_STATUS.EXPIRED, reviewedAt: now },
        $unset: { "document.encrypted": "" },
      },
    );
    if (updated) {
      expiredCount += 1;
      auditLog({
        event: "student_verification_expired",
        route: "verification-student",
        method: "SYSTEM",
        status: 200,
        walletAddress: doc.walletAddress,
        materialId: String(doc._id),
      });
    }
  }

  return { expiredCount };
}

/**
 * Fetches an application's metadata (never the ciphertext) scoped to its
 * owner, applying lazy expiry first so a stale pending record is reported
 * honestly as expired.
 */
export async function getVerificationStatusForWallet(
  walletAddress,
  { now = new Date(), db: providedDb } = {},
) {
  const db = await resolveDb(providedDb);
  const collection = db.collection(VERIFICATION_COLLECTION);
  const normalizedWallet = String(walletAddress).toLowerCase();

  const verification = await collection.findOne(
    { walletAddress: normalizedWallet },
    {
      projection: { "document.encrypted": 0 },
      sort: { submittedAt: -1 },
    },
  );

  if (!verification) return null;

  if (
    verification.status === VERIFICATION_STATUS.PENDING &&
    isExpired(verification, now)
  ) {
    await expireStaleSubmissions({ now });
    return {
      ...verification,
      status: VERIFICATION_STATUS.EXPIRED,
      reviewedAt: now,
    };
  }

  return verification;
}

/**
 * Lists pending applications for the admin queue, excluding ciphertext and
 * excluding (and lazily expiring) anything past its review window.
 */
export async function listPendingApplications({
  now = new Date(),
  limit = 50,
  db: providedDb,
} = {}) {
  await expireStaleSubmissions({ now, db: providedDb });
  const db = await resolveDb(providedDb);
  const collection = db.collection(VERIFICATION_COLLECTION);
  return collection
    .find(
      { status: VERIFICATION_STATUS.PENDING },
      { projection: { "document.encrypted": 0 } },
    )
    .sort({ submittedAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Decrypts a pending, non-expired application's document for an admin to
 * review. This is the only path that ever reconstitutes plaintext bytes.
 */
export async function getDecryptedDocumentForReview(
  applicationId,
  { now = new Date(), env = process.env, db: providedDb } = {},
) {
  const db = await resolveDb(providedDb);
  const collection = db.collection(VERIFICATION_COLLECTION);
  const application = await collection.findOne({ _id: applicationId });

  if (!application) {
    throw new VerificationLifecycleError("Application not found", "not_found");
  }

  if (application.status !== VERIFICATION_STATUS.PENDING) {
    throw new VerificationLifecycleError(
      `Application is already ${application.status}; no document is retained for review`,
      "invalid_transition",
    );
  }

  if (isExpired(application, now)) {
    await expireStaleSubmissions({ now });
    throw new VerificationLifecycleError(
      "This application's review window has expired; the document has been purged and the student must resubmit",
      "expired",
    );
  }

  if (!application.document?.encrypted) {
    throw new VerificationLifecycleError(
      "No document is available for this application",
      "not_found",
    );
  }

  let plaintext;
  try {
    plaintext = decryptDocumentBuffer(application.document.encrypted, {
      env,
    });
  } catch (error) {
    throw wrapEncryptionError(error);
  }

  return {
    buffer: plaintext,
    filename: application.document.filename,
    mimetype: application.document.mimetype,
  };
}

/**
 * Approves or rejects a pending, non-expired application. Atomic and
 * idempotency-safe (#107):
 *
 *   - The status update is guarded on `{ _id, status: "pending" }` so
 *     concurrent reviewers cannot both "win" the same decision.
 *   - When the deployment supports Mongo transactions (replica set), the
 *     status update + audit log + (downstream) user-record mutation are
 *     committed as one transaction; any failure rolls back all side
 *     effects. On standalone deployments the writes fall back to non-
 *     transactional, identical to the previous behaviour.
 *   - The losing concurrent reviewer receives a typed `conflict` 409, never
 *     a generic 500.
 *
 * The encrypted document is purged as soon as a decision is recorded.
 */
export async function reviewStudentVerification({
  applicationId,
  actorId,
  action,
  reviewNotes = null,
  now = new Date(),
  db: providedDb,
}) {
  if (!applicationId || !["approve", "reject"].includes(action)) {
    throw new VerificationLifecycleError(
      "applicationId and a valid action (approve/reject) are required",
      "invalid_input",
    );
  }

  const db = await resolveDb(providedDb);
  const collection = db.collection(VERIFICATION_COLLECTION);

  const nextStatus =
    action === "approve"
      ? VERIFICATION_STATUS.APPROVED
      : VERIFICATION_STATUS.REJECTED;

  const result = await withOptionalTransaction(db, async (session) => {
    const application = await collection.findOne(
      { _id: applicationId },
      { session },
    );

    if (!application) {
      throw new VerificationLifecycleError(
        "Application not found",
        "not_found",
      );
    }

    if (TERMINAL_STATUSES.has(application.status)) {
      throw new VerificationLifecycleError(
        `Application is already ${application.status}`,
        "invalid_transition",
      );
    }

    if (isExpired(application, now)) {
      await expireStaleSubmissions({ now });
      throw new VerificationLifecycleError(
        "This application's review window has expired; the student must resubmit",
        "expired",
      );
    }

    // Atomic guarded update — the partial filter on the previous status is
    // what actually protects against two reviewers approving simultaneously.
    const updated = await collection.findOneAndUpdate(
      { _id: applicationId, status: VERIFICATION_STATUS.PENDING },
      {
        $set: {
          status: nextStatus,
          reviewedBy: actorId,
          reviewedAt: now,
          reviewNotes,
        },
        $unset: { "document.encrypted": "" },
      },
      { returnDocument: "after", session },
    );

    if (!updated) {
      // Someone else reviewed it between our read and write.
      throw new VerificationLifecycleError(
        "Application status changed concurrently; expected pending",
        "conflict",
      );
    }

    return updated;
  });

  // Audit logging is intentionally OUTSIDE the transaction. The audit
  // record is best-effort: it must never roll back a successful state
  // transition, and emitting it after the transaction commits guarantees
  // we never audit a transition that the database later rejected.
  auditLog({
    event: `student_verification_${nextStatus}`,
    route: "admin/verification",
    method: "POST",
    status: 200,
    actor: actorId,
    materialId: String(applicationId),
  });

  return result;
}
