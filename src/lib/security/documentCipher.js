import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encryption-at-rest for uploaded verification documents (student ID scans,
 * enrollment letters, transcripts, etc.).
 *
 * Academic verification evidence is high-risk personal data (issue #165): it
 * must never be persisted as a raw buffer. Every document is encrypted with
 * AES-256-GCM using a per-document random IV before it is written to Mongo,
 * and is only decrypted transiently, in memory, for the admin review flow.
 *
 * Key material comes from VERIFICATION_DOCUMENT_KEY — a 32-byte key encoded
 * as 64 hex characters or standard/url-safe base64. There is no plaintext
 * fallback: if the key is missing or malformed, encryption (and therefore
 * document submission) fails safely instead of silently storing plaintext.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12; // NIST-recommended IV length for GCM
const KEY_LENGTH_BYTES = 32; // AES-256

export class DocumentEncryptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DocumentEncryptionError";
    this.code = code;
  }
}

function decodeKeyMaterial(raw) {
  const trimmed = raw.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(normalized, "base64");
    if (buf.length === KEY_LENGTH_BYTES) {
      return buf;
    }
  } catch {
    // fall through to the length check below, which throws a typed error
  }

  return null;
}

/**
 * Resolves and validates the document encryption key from the environment.
 * Throws DocumentEncryptionError("missing_key" | "invalid_key") rather than
 * ever returning a fallback — callers must not persist unencrypted data.
 */
export function getDocumentEncryptionKey(env = process.env) {
  const raw = env.VERIFICATION_DOCUMENT_KEY;
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw new DocumentEncryptionError(
      "VERIFICATION_DOCUMENT_KEY is not configured; refusing to store verification documents unencrypted.",
      "missing_key"
    );
  }

  const key = decodeKeyMaterial(raw);
  if (!key || key.length !== KEY_LENGTH_BYTES) {
    throw new DocumentEncryptionError(
      "VERIFICATION_DOCUMENT_KEY must decode to exactly 32 bytes (64 hex chars or base64).",
      "invalid_key"
    );
  }

  return key;
}

/**
 * Encrypts a document buffer for at-rest storage.
 * @param {Buffer} plaintext
 * @param {{ env?: object }} [options]
 * @returns {{ ciphertext: string, iv: string, authTag: string, algorithm: string }}
 *   base64-encoded ciphertext/iv/authTag, safe to persist in Mongo.
 */
export function encryptDocumentBuffer(plaintext, { env = process.env } = {}) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0) {
    throw new DocumentEncryptionError("Cannot encrypt an empty document buffer.", "empty_input");
  }

  const key = getDocumentEncryptionKey(env);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: ALGORITHM,
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypts a document previously produced by encryptDocumentBuffer.
 * Throws DocumentEncryptionError("decrypt_failed") on any tamper/corruption
 * (wrong key, flipped bits, truncated ciphertext) — GCM's auth tag check
 * makes this fail closed rather than returning corrupted plaintext.
 */
export function decryptDocumentBuffer(record, { env = process.env } = {}) {
  if (!record || typeof record !== "object") {
    throw new DocumentEncryptionError("Missing encrypted document payload.", "malformed_input");
  }

  const { ciphertext, iv, authTag, algorithm = ALGORITHM } = record;
  if (!ciphertext || !iv || !authTag) {
    throw new DocumentEncryptionError("Encrypted document payload is incomplete.", "malformed_input");
  }
  if (algorithm !== ALGORITHM) {
    throw new DocumentEncryptionError(`Unsupported encryption algorithm: ${algorithm}`, "unsupported_algorithm");
  }

  const key = getDocumentEncryptionKey(env);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  } catch (error) {
    throw new DocumentEncryptionError(
      "Failed to decrypt verification document; data may be corrupted or tampered with.",
      "decrypt_failed"
    );
  }
}

/**
 * Constant-time comparison helper for identifiers derived from encrypted
 * material (not currently used outside tests, kept for callers that need to
 * compare digests without leaking timing information).
 */
export function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
