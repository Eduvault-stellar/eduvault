/**
 * File-type policy for EduVault educational material uploads.
 *
 * Centralises all MIME-type allow-lists, per-purpose size limits, and the
 * human-readable descriptions shown in creator-facing error messages.  Every
 * enforcement point in the upload pipeline (route handler, quarantine worker,
 * API validation) should import from here so that adding a new format or
 * changing a limit is a single-file change.
 *
 * Relevant issue: Eduvault-stellar/eduvault#203
 */

// ---------------------------------------------------------------------------
// Allowed educational document MIME types
// ---------------------------------------------------------------------------

/** MIME types accepted for the main learning-material file. */
export const ALLOWED_DOCUMENT_TYPES = Object.freeze([
  'application/pdf',
  'application/msword',                                                           // .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',     // .docx
  'application/vnd.ms-excel',                                                    // .xls
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',           // .xlsx
  'application/vnd.ms-powerpoint',                                               // .ppt
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',   // .pptx
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
]);

/** Human-readable labels shown in creator-facing validation errors. */
export const DOCUMENT_TYPE_LABELS = Object.freeze({
  'application/pdf':       'PDF (.pdf)',
  'application/msword':    'Word document (.doc)',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document (.docx)',
  'application/vnd.ms-excel':   'Excel spreadsheet (.xls)',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       'Excel spreadsheet (.xlsx)',
  'application/vnd.ms-powerpoint':    'PowerPoint presentation (.ppt)',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation (.pptx)',
  'text/plain':                'Plain text (.txt)',
  'application/zip':           'ZIP archive (.zip)',
  'application/x-zip-compressed': 'ZIP archive (.zip)',
});

/** Allowed MIME types for thumbnail / cover images. */
export const ALLOWED_THUMBNAIL_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

/** Maximum bytes for a learning-material document upload (10 MB). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Maximum bytes for a thumbnail / cover image upload (5 MB). */
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helper — build actionable creator-facing error messages
// ---------------------------------------------------------------------------

/**
 * Returns a structured validation result for a document file.
 *
 * @param {{ name: string, type: string, size: number }} file
 * @returns {{ valid: boolean, code?: string, message?: string }}
 */
export function validateDocumentPolicy(file) {
  if (!file) {
    return { valid: false, code: 'MISSING_FILE', message: 'No document file was provided.' };
  }

  const mimeType = (file.type || '').toLowerCase();
  const sizeMB   = (file.size / (1024 * 1024)).toFixed(2);

  if (file.size > MAX_DOCUMENT_BYTES) {
    return {
      valid:   false,
      code:    'FILE_TOO_LARGE',
      message: `Your file (${sizeMB} MB) exceeds the 10 MB limit. ` +
               `Please compress or split the document before uploading.`,
    };
  }

  if (!ALLOWED_DOCUMENT_TYPES.includes(mimeType)) {
    const allowed = [...new Set(Object.values(DOCUMENT_TYPE_LABELS))].join(', ');
    return {
      valid:   false,
      code:    'UNSUPPORTED_TYPE',
      message: `"${mimeType || file.name}" is not an accepted file type. ` +
               `Allowed formats: ${allowed}.`,
    };
  }

  return { valid: true };
}

/**
 * Returns a structured validation result for a thumbnail image.
 *
 * @param {{ name: string, type: string, size: number } | null} image
 * @returns {{ valid: boolean, code?: string, message?: string }}
 */
export function validateThumbnailPolicy(image) {
  if (!image) return { valid: true }; // thumbnail is optional

  const mimeType = (image.type || '').toLowerCase();
  const sizeMB   = (image.size / (1024 * 1024)).toFixed(2);

  if (image.size > MAX_THUMBNAIL_BYTES) {
    return {
      valid:   false,
      code:    'THUMBNAIL_TOO_LARGE',
      message: `Your thumbnail (${sizeMB} MB) exceeds the 5 MB limit. ` +
               `Please resize the image to under 5 MB.`,
    };
  }

  if (!ALLOWED_THUMBNAIL_TYPES.includes(mimeType)) {
    return {
      valid:   false,
      code:    'UNSUPPORTED_THUMBNAIL_TYPE',
      message: `"${mimeType || image.name}" is not accepted for thumbnails. ` +
               `Please upload a JPEG, PNG, or WebP image.`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Scanner-failure behaviour contract
// ---------------------------------------------------------------------------

/**
 * Codes returned by the quarantine worker on scanner failure.
 *
 * Written to the `upload_quarantine` collection so maintainers can filter and
 * review rejected uploads directly in the database or admin UI.
 */
export const QUARANTINE_REJECTION_REASONS = Object.freeze({
  UNSAFE_ARCHIVE:  'unsafe_archive',   // ZIP bomb / deep nesting / oversized expansion
  SCANNER_VERDICT: 'scanner_verdict',  // Antivirus / threat signature match
  SCAN_TIMEOUT:    'scan_timeout',     // Worker lease expired without result
  SCAN_ERROR:      'scan_error',       // Unexpected scanner crash / network failure
});

/**
 * Creator-facing message for each quarantine rejection reason.
 *
 * Shown via the API response so creators understand why their upload was
 * blocked without exposing internal scanner details.
 */
export const QUARANTINE_CREATOR_MESSAGES = Object.freeze({
  [QUARANTINE_REJECTION_REASONS.UNSAFE_ARCHIVE]:
    'Your ZIP archive was rejected because it exceeds our depth or expansion limits. ' +
    'Please re-package with a maximum nesting depth of 5 and an uncompressed size under 100 MB.',

  [QUARANTINE_REJECTION_REASONS.SCANNER_VERDICT]:
    'Our security scanner flagged this file as potentially unsafe. ' +
    'If you believe this is a false positive, please contact support with your upload reference ID.',

  [QUARANTINE_REJECTION_REASONS.SCAN_TIMEOUT]:
    'The security scan timed out. Your file has been queued for a retry. ' +
    'You will be notified once scanning completes.',

  [QUARANTINE_REJECTION_REASONS.SCAN_ERROR]:
    'An error occurred during security scanning. Your upload has been preserved and ' +
    'will be retried automatically. Please check back shortly.',
});
