/**
 * Validates uploaded file byte streams by inspecting magic numbers / file headers
 * before dispatching to Pinata. Prevents malformed or spoofed files from being pinned.
 */

// Magic number signatures keyed by MIME type
const SIGNATURES = {
  'application/pdf': [
    { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  ],
  'application/zip': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK (local file header)
    { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }, // PK (empty archive)
  ],
  'application/x-zip-compressed': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
    { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  ],
  // .doc / .xls / .ppt — Compound Document (OLE2) format
  'application/msword': [
    { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  ],
  'application/vnd.ms-excel': [
    { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  ],
  'application/vnd.ms-powerpoint': [
    { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  ],
  // .docx / .xlsx / .pptx — OOXML (ZIP-based)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  ],
  // Images
  'image/jpeg': [
    { offset: 0, bytes: [0xff, 0xd8, 0xff] },
  ],
  'image/png': [
    { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  ],
  'image/webp': [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF — verified alongside WEBP marker below
  ],
};

// WEBP requires an additional check at bytes 8–11
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

// text/plain has no magic number; we validate it is valid UTF-8 with a heuristic check
const NULL_BYTE_THRESHOLD = 0.01; // >1% null bytes = likely binary

/**
 * Reads the first `n` bytes of a Web API File/Blob.
 * @param {File} file
 * @param {number} n
 * @returns {Promise<Uint8Array>}
 */
async function readHeader(file, n) {
  const slice = file.slice(0, n);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Checks whether `header` starts with `sig.bytes` at `sig.offset`.
 */
function matchesSignature(header, sig) {
  if (header.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => header[sig.offset + i] === b);
}

/**
 * Validates that the file's binary header matches the declared MIME type.
 *
 * @param {File} file - Web API File object (has .type and .slice)
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateFileMagicNumber(file) {
  const mimeType = (file.type || '').toLowerCase();

  // text/plain: heuristic — reject if more than 1% of sampled bytes are null
  if (mimeType === 'text/plain') {
    const sampleSize = Math.min(file.size, 4096);
    const header = await readHeader(file, sampleSize);
    const nullCount = header.reduce((acc, b) => acc + (b === 0x00 ? 1 : 0), 0);
    if (nullCount / header.length > NULL_BYTE_THRESHOLD) {
      return { valid: false, reason: 'File declared as text/plain but contains binary data.' };
    }
    return { valid: true };
  }

  // WEBP requires two separate checks
  if (mimeType === 'image/webp') {
    const header = await readHeader(file, 12);
    const hasRiff = matchesSignature(header, { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] });
    const hasWebp = WEBP_MARKER.every((b, i) => header[8 + i] === b);
    if (!hasRiff || !hasWebp) {
      return { valid: false, reason: 'File header does not match image/webp (expected RIFF….WEBP).' };
    }
    return { valid: true };
  }

  const sigs = SIGNATURES[mimeType];
  if (!sigs) {
    // Unknown / unregistered type — allow through; other validators handle allowlisting
    return { valid: true };
  }

  const maxSigLen = Math.max(...sigs.map(s => s.offset + s.bytes.length));
  const header = await readHeader(file, maxSigLen);

  const matched = sigs.some(sig => matchesSignature(header, sig));
  if (!matched) {
    return {
      valid: false,
      reason: `File header does not match declared MIME type "${mimeType}". The file may be corrupt or misidentified.`,
    };
  }

  return { valid: true };
}

/**
 * Validates both MIME type allowlist and magic number for a document file.
 *
 * @param {File} file
 * @param {string[]} allowedTypes - list of permitted MIME types
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateUploadedFile(file, allowedTypes) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    return { valid: false, reason: 'Invalid file object.' };
  }

  const mimeType = (file.type || '').toLowerCase();

  if (!allowedTypes.includes(mimeType)) {
    return {
      valid: false,
      reason: `Unsupported file type: ${mimeType || 'unknown'}.`,
    };
  }

  return validateFileMagicNumber(file);
}
