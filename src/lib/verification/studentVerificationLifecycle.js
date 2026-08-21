/**
 * Student Verification Document Lifecycle (issue #165)
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
import { encryptDocumentBuffer, decryptDocumentBuffer, DocumentEncryptionError } from "@/lib/security/documentCipher";

export const VERIFICATION_COLLECTION = "student_verifications";

export const VERIFICATION_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
});

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
  invalid_transition: 409,
  conflict: 409,
  expired: 410,
  encryption_unavailable: 503,
});

export function statusToHttp(code) {
  return LIFECYCLE_ERROR_HTTP_STATUS[code] || 500;
}

function wrapEncryptionError(error) {
  if (error instanceof DocumentEncryptionError) {
    // Never leak the raw crypto error detail (secrets/paths) — map to a
    // typed, safely-loggable lifecycle error instead.
    return new VerificationLifecycleError(
      "Document could not be processed securely.",
      error.code === "decrypt_failed" ? "conflict" : "encryption_unavailable"
    );
  }
  return error;
}

function isExpired(record, now = new Date()) {
  return !!record.documentExpiresAt && record.documentExpiresAt.getTime() <= now.getTime();
}

/**
 * Validates + encrypts an uploaded document and creates a new pending
 * verification record. Idempotent against duplicate active submissions from
 * the same wallet (existing pending/approved application blocks a new one).
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
}) {
  if (
    !walletAddress ||
    !fullName ||
    !email ||
    !institution ||
    !studentId ||
    !expectedGraduation ||
    !documentBuffer
  ) {
    throw new VerificationLifecycleError("All fields are required", "invalid_input");
  }

  if (documentSize > MAX_DOCUMENT_SIZE_BYTES) {
    throw new VerificationLifecycleError("File size exceeds 5MB limit", "invalid_input");
  }

  if (!VALID_DOCUMENT_MIME_TYPES.includes(documentMimeType)) {
    throw new VerificationLifecycleError(
      "Invalid file type. Only JPG, PNG, and PDF are allowed",
      "invalid_input"
    );
  }

  const normalizedWallet = String(walletAddress).toLowerCase();
  const db = await getDb();
  const collection = db.collection(VERIFICATION_COLLECTION);

  const existing = await collection.findOne({
    walletAddress: normalizedWallet,
    status: { $in: [VERIFICATION_STATUS.PENDING, VERIFICATION_STATUS.APPROVED] },
  });

  if (existing) {
    throw new VerificationLifecycleError(
      "You already have a pending or approved verification application",
      "duplicate_submission"
    );
  }

  let encrypted;
  try {
    encrypted = encryptDocumentBuffer(documentBuffer, { env });
  } catch (error) {
    throw wrapEncryptionError(error);
  }

  const submittedAt = now;
  const documentExpiresAt = new Date(submittedAt.getTime() + getReviewWindowMs(env));

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

  const result = await collection.insertOne(record);

  auditLog({
    event: "student_verification_submitted",
    route: "verification-student",
    method: "POST",
    status: 201,
    walletAddress: normalizedWallet,
    materialId: String(result.insertedId),
  });

  return { ...record, _id: result.insertedId };
}

/**
 * Lazily expires any pending applications whose review window has elapsed
 * and purges their encrypted document payload. Safe to call opportunistically
 * from read paths (GET) since it only touches documents that are already
 * stale — no scheduler/cron dependency required.
 */
export async function expireStaleSubmissions({ now = new Date() } = {}) {
  const db = await getDb();
  const collection = db.collection(VERIFICATION_COLLECTION);

  const stale = await collection
    .find({ status: VERIFICATION_STATUS.PENDING, documentExpiresAt: { $lte: now } })
    .project({ _id: 1, walletAddress: 1 })
    .toArray();

  let expiredCount = 0;
  for (const doc of stale) {
    const updated = await collection.findOneAndUpdate(
      { _id: doc._id, status: VERIFICATION_STATUS.PENDING },
      {
        $set: { status: VERIFICATION_STATUS.EXPIRED, reviewedAt: now },
        $unset: { "document.encrypted": "" },
      }
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
export async function getVerificationStatusForWallet(walletAddress, { now = new Date() } = {}) {
  const db = await getDb();
  const collection = db.collection(VERIFICATION_COLLECTION);
  const normalizedWallet = String(walletAddress).toLowerCase();

  const verification = await collection.findOne(
    { walletAddress: normalizedWallet },
    { projection: { "document.encrypted": 0 }, sort: { submittedAt: -1 } }
  );

  if (!verification) return null;

  if (verification.status === VERIFICATION_STATUS.PENDING && isExpired(verification, now)) {
    await expireStaleSubmissions({ now });
    return { ...verification, status: VERIFICATION_STATUS.EXPIRED, reviewedAt: now };
  }

  return verification;
}

/**
 * Lists pending applications for the admin queue, excluding ciphertext and
 * excluding (and lazily expiring) anything past its review window.
 */
export async function listPendingApplications({ now = new Date(), limit = 50 } = {}) {
  await expireStaleSubmissions({ now });
  const db = await getDb();
  const collection = db.collection(VERIFICATION_COLLECTION);
  return collection
    .find({ status: VERIFICATION_STATUS.PENDING }, { projection: { "document.encrypted": 0 } })
    .sort({ submittedAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Decrypts a pending, non-expired application's document for an admin to
 * review. This is the only path that ever reconstitutes plaintext bytes.
 */
export async function getDecryptedDocumentForReview(applicationId, { now = new Date(), env = process.env } = {}) {
  const db = await getDb();
  const collection = db.collection(VERIFICATION_COLLECTION);
  const application = await collection.findOne({ _id: applicationId });

  if (!application) {
    throw new VerificationLifecycleError("Application not found", "not_found");
  }

  if (application.status !== VERIFICATION_STATUS.PENDING) {
    throw new VerificationLifecycleError(
      `Application is already ${application.status}; no document is retained for review`,
      "invalid_transition"
    );
  }

  if (isExpired(application, now)) {
    await expireStaleSubmissions({ now });
    throw new VerificationLifecycleError(
      "This application's review window has expired; the document has been purged and the student must resubmit",
      "expired"
    );
  }

  if (!application.document?.encrypted) {
    throw new VerificationLifecycleError("No document is available for this application", "not_found");
  }

  let plaintext;
  try {
    plaintext = decryptDocumentBuffer(application.document.encrypted, { env });
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
 * idempotency-safe: the update is guarded on { _id, status: "pending" } so
 * concurrent reviewers cannot both "win" the same decision, and the
 * encrypted document is purged as soon as a decision is recorded.
 */
export async function reviewStudentVerification({ applicationId, actorId, action, reviewNotes = null, now = new Date() }) {
  if (!applicationId || !["approve", "reject"].includes(action)) {
    throw new VerificationLifecycleError(
      "applicationId and a valid action (approve/reject) are required",
      "invalid_input"
    );
  }

  const db = await getDb();
  const collection = db.collection(VERIFICATION_COLLECTION);
  const application = await collection.findOne({ _id: applicationId });

  if (!application) {
    throw new VerificationLifecycleError("Application not found", "not_found");
  }

  if (TERMINAL_STATUSES.has(application.status)) {
    throw new VerificationLifecycleError(`Application is already ${application.status}`, "invalid_transition");
  }

  if (isExpired(application, now)) {
    await expireStaleSubmissions({ now });
    throw new VerificationLifecycleError(
      "This application's review window has expired; the student must resubmit",
      "expired"
    );
  }

  const nextStatus = action === "approve" ? VERIFICATION_STATUS.APPROVED : VERIFICATION_STATUS.REJECTED;

  const updated = await collection.findOneAndUpdate(
    { _id: applicationId, status: VERIFICATION_STATUS.PENDING },
    {
      $set: { status: nextStatus, reviewedBy: actorId, reviewedAt: now, reviewNotes },
      $unset: { "document.encrypted": "" },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    // Someone else reviewed it between our read and write.
    throw new VerificationLifecycleError(
      "Application status changed concurrently; expected pending",
      "conflict"
    );
  }

  auditLog({
    event: `student_verification_${nextStatus}`,
    route: "admin/verification",
    method: "POST",
    status: 200,
    actor: actorId,
    materialId: String(applicationId),
  });

  return updated;
}
