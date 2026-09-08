# Security Policy

This document describes EduVault's upload security controls and the technical
decisions behind them.  It is aimed at maintainers and security reviewers.

---

## Upload file-type policy

### Allowed MIME types

Only a curated allow-list of educational document MIME types may be uploaded.
The list is the single source of truth in
[`src/lib/uploads/fileTypePolicy.js`](../src/lib/uploads/fileTypePolicy.js):

**Document files (10 MB max)**

| MIME type | Extension |
|-----------|-----------|
| `application/pdf` | `.pdf` |
| `application/msword` | `.doc` |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` |
| `application/vnd.ms-excel` | `.xls` |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `.xlsx` |
| `application/vnd.ms-powerpoint` | `.ppt` |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `.pptx` |
| `text/plain` | `.txt` |
| `application/zip` | `.zip` |
| `application/x-zip-compressed` | `.zip` |

**Thumbnail images (5 MB max)**

| MIME type | Extension |
|-----------|-----------|
| `image/jpeg` | `.jpg / .jpeg` |
| `image/png` | `.png` |
| `image/webp` | `.webp` |

### Rationale

Restricting to known document formats prevents:
- Upload of executable binaries (`.exe`, `.sh`, `.py`) that could be served to students.
- Macro-embedded documents from untrusted vectors (enforced further by the scanner).
- Polyglot files that exploit lenient MIME-type parsing in downstream renderers.

---

## Magic-number (byte-level) validation

After the MIME-type allow-list check, the server reads the raw file header and
compares it against known magic-byte signatures
([`src/lib/ipfs/uploadValidator.js`](../src/lib/ipfs/uploadValidator.js)).

This prevents **type-spoofing attacks** where an attacker renames an `.exe`
to `notes.pdf` and uploads it with a forged `Content-Type` header.

### Validation rules by type

| Type | Validation |
|------|-----------|
| PDF | Header starts with `%PDF` (`25 50 44 46`) |
| ZIP / OOXML | Header starts with `PK` (`50 4B 03 04` or `50 4B 05 06`) |
| OLE2 (`.doc/.xls/.ppt`) | Header matches `D0 CF 11 E0 A1 B1 1A E1` |
| JPEG | Header starts with `FF D8 FF` |
| PNG | Header starts with `89 50 4E 47 0D 0A 1A 0A` |
| WebP | Header starts with `RIFF` and bytes 8–11 are `WEBP` |
| `text/plain` | < 1% null bytes in the first 4 096 bytes |

---

## Quarantine & virus scanning

All uploads that pass MIME and magic-number checks are placed in the
**quarantine queue** (`upload_quarantine` MongoDB collection) before any content
is published or made reward-eligible.

### Quarantine lifecycle

```
QUARANTINED → SCANNING → APPROVED
                       └→ REJECTED
             └→ SCAN_FAILED  (retryable — lease expires and job is re-leased)
```

### Scanner integration

A separately deployed scan worker leases one job at a time via the
`scanNextUpload` function in
[`src/lib/uploads/quarantine.js`](../src/lib/uploads/quarantine.js).

The worker:
- Runs **without** application credentials or signing keys.
- Records `engineVersion` and `rulesVersion` on every verdict.
- Strips the raw `payload` bytes from the database record upon completion (approved or rejected), retaining only the SHA-256 digest and verdict for audit.

### Archive safety limits

ZIP archives are subject to additional structural limits enforced from scanner
metadata:

| Limit | Value |
|-------|-------|
| Maximum entries | 1 000 |
| Maximum uncompressed size | 100 MB |
| Maximum nesting depth | 5 levels |

Exceeding any of these limits results in an `unsafe_archive` rejection,
regardless of virus-scan outcome.

### Scanner failure behaviour

| State | Cause | Creator impact | Retry? |
|-------|-------|---------------|--------|
| `APPROVED` | Clean file, within archive limits | Published immediately | — |
| `REJECTED` / `scanner_verdict` | Threat signature matched | Creator notified; file unavailable | No |
| `REJECTED` / `unsafe_archive` | Archive limit exceeded | Creator notified with specific limit | No |
| `SCAN_FAILED` | Scanner crash or network error | Creator informed; file preserved | **Yes** — automatic |

`SCAN_FAILED` jobs retain their `payload` bytes so the worker can pick them up
again once the lease expires.  The worker increments `attempts` on each lease;
integrators may set a `maxAttempts` gate and escalate to manual review.

---

## Audit logging

Every upload event — including rejections and scanner verdicts — is written to
the application audit log via `auditLog()` with a structured `event`, `route`,
`method`, `status`, and `reason` field.  This ensures that maintainers have a
complete, maintainer-visible trace of why any upload was blocked.

---

## Responsible disclosure

If you discover a security vulnerability in EduVault, please report it
privately before opening a public issue.  See
[`docs/contributing.md`](./contributing.md) for contact details.
