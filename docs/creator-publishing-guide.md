# Creator Publishing Guide

This guide explains how to prepare and upload educational materials to EduVault, including file-type requirements, size limits, and what happens if a file fails our security checks.

---

## Supported file formats

Only the following formats may be uploaded as learning materials:

| Format | MIME type | Extension(s) |
|--------|-----------|--------------|
| PDF document | `application/pdf` | `.pdf` |
| Word document | `application/msword` | `.doc` |
| Word document (modern) | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` |
| Excel spreadsheet | `application/vnd.ms-excel` | `.xls` |
| Excel spreadsheet (modern) | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `.xlsx` |
| PowerPoint presentation | `application/vnd.ms-powerpoint` | `.ppt` |
| PowerPoint presentation (modern) | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `.pptx` |
| Plain text | `text/plain` | `.txt` |
| ZIP archive | `application/zip` | `.zip` |

Thumbnail / cover images must be **JPEG**, **PNG**, or **WebP** only.

> **Why these formats?**  
> Restricting uploads to known educational document formats lets our virus scanner apply the correct parsing rules and prevents executable or script files from entering the content pipeline.

---

## Size limits

| Field | Maximum size |
|-------|-------------|
| Learning-material file | **10 MB** |
| Thumbnail / cover image | **5 MB** |

If your document exceeds 10 MB, consider:
- Compressing embedded images inside the document (most PDF editors and Word have this built-in).
- Splitting a large course into individual chapter files and uploading them as separate materials.

---

## Upload flow

```
Creator selects file
        │
        ▼
┌─────────────────────────────────────┐
│  1. MIME-type & size check          │  Immediate (client + server)
│     • Unsupported type → 415        │
│     • File too large   → 413        │
└──────────────┬──────────────────────┘
               │ passes
               ▼
┌─────────────────────────────────────┐
│  2. Magic-number / header check     │  Server — byte-level validation
│     • Header mismatch → 415         │  Prevents type spoofing
└──────────────┬──────────────────────┘
               │ passes
               ▼
┌─────────────────────────────────────┐
│  3. Quarantine & virus scan         │  Asynchronous worker
│     • Clean → APPROVED              │  File promoted to storage
│     • Threat / unsafe archive       │
│       → REJECTED (see below)        │
│     • Scanner error → SCAN_FAILED   │  Automatically retried
└──────────────┬──────────────────────┘
               │ approved
               ▼
        Published / reward-eligible
```

---

## What happens when a file is rejected?

Every rejection produces an **actionable error message** with a `code` field so you know exactly what to fix.

### Type or size errors (immediate, HTTP 4xx)

| HTTP status | `code` | What to do |
|-------------|--------|-----------|
| 400 | `MISSING_FILE` | Attach a document file before submitting. |
| 413 | `FILE_TOO_LARGE` | Reduce the file below 10 MB. |
| 413 | `THUMBNAIL_TOO_LARGE` | Reduce the thumbnail below 5 MB. |
| 415 | `UNSUPPORTED_TYPE` | Convert to one of the accepted formats listed above. |
| 415 | `UNSUPPORTED_THUMBNAIL_TYPE` | Re-export your cover image as JPEG, PNG, or WebP. |

### Quarantine / scanner rejection

If a file passes the immediate checks but is flagged by the security scanner, you will see one of the following messages:

| Reason | Creator message |
|--------|----------------|
| `unsafe_archive` | Your ZIP archive was rejected because it exceeds our depth or expansion limits. Please re-package with a maximum nesting depth of 5 and an uncompressed size under 100 MB. |
| `scanner_verdict` | Our security scanner flagged this file as potentially unsafe. If you believe this is a false positive, please contact support with your upload reference ID. |
| `scan_timeout` | The security scan timed out. Your file has been queued for a retry. You will be notified once scanning completes. |
| `scan_error` | An error occurred during security scanning. Your upload has been preserved and will be retried automatically. |

> Files in `scan_timeout` or `scan_error` states are **not lost** — they remain in the quarantine queue and are retried by the scan worker automatically.  You do not need to re-upload the file.

---

## ZIP archive rules

ZIP files are accepted, but the scanner enforces additional limits to prevent archive-based exploits:

- Maximum **1 000 entries** inside the archive.
- Maximum **100 MB** total uncompressed size.
- Maximum **5 levels** of nested directories or nested archives.

If your ZIP fails these limits, re-package it by removing unnecessary files or flattening the directory structure.

---

## Maintainer visibility

All quarantine events — including rejections with their reasons — are written to the `upload_quarantine` collection and to the platform audit log.  Maintainers can query and override decisions using the admin interface.

---

## Related documentation

- [Security policy](./security.md)
- [Upload quarantine internals](./upload-quarantine.md)
- [Material lifecycle](./material-lifecycle.md)
