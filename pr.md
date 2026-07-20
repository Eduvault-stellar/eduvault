# Pull Request: Backend Platform Hardening & Automation

## Summary

This PR implements four backend features covering upload security, automated admin reporting, account suspension notifications, and backup integrity verification.

---

## Changes

### #365 — Upload checks validating files pinned to Pinata

**Files:**
- `src/lib/ipfs/uploadValidator.js` *(new)*
- `src/app/api/materials/upload/route.js` *(new)*

**What changed:**
Introduced a byte-stream validator that inspects magic number / file header signatures before any file is dispatched to Pinata. The new `src/app/api/materials/upload` route applies this validation in addition to the existing MIME type allowlist and size checks. Files whose headers do not match their declared MIME type are rejected with HTTP 422 before pinning. Invalid files never reach Pinata, and no MongoDB records are written for rejected uploads.

**Supported signatures:** PDF, ZIP, OLE2 compound documents (.doc/.xls/.ppt), OOXML containers (.docx/.xlsx/.pptx), JPEG, PNG, WEBP. Plain-text files are validated via a binary-null-byte heuristic.

---

### #363 — Weekly marketplace performance email reports to admins

**Files:**
- `src/lib/email/adminReport.js` *(new)*
- `scripts/weekly-admin-stats.mjs` *(new)*

**What changed:**
Added an aggregator service (`adminReport.js`) that queries MongoDB for the previous week's completed sales, total revenue, new user registrations, new material uploads, and active listing counts. A clean HTML summary email (with plain-text fallback) is generated and sent to all addresses in `ADMIN_REPORT_EMAILS`.

The companion cron script (`weekly-admin-stats.mjs`) is a standalone Node.js entrypoint with no Next.js dependency, intended to run every Monday via cron:

```
0 8 * * 1  node scripts/weekly-admin-stats.mjs
```

Structured JSON is logged at every step so output can be piped into any log aggregator and delivery is confirmed in the log output.

---

### #369 — Email notifications for account suspension

**Files:**
- `src/lib/email/suspensionNotifier.js` *(new)*
- `src/app/api/admin/users/suspend/route.js` *(new)*

**What changed:**
Added a `suspensionNotifier` module exporting `sendSuspensionEmail` and `sendReactivationEmail`. Each sends a branded HTML email (with plain-text fallback) explaining the status change, the stated reason, appeal instructions, and a link to community guidelines.

The new `POST /api/admin/users/suspend` route accepts `{ userId, action, reason }`, updates the user's `status` field in MongoDB, writes an audit log entry, then dispatches the appropriate notification email. Email failures are caught and logged without blocking the admin action response. The `emailSent` boolean is returned in the response payload for confirmation.

---

### #364 — Database backup collection archives verification script

**Files:**
- `scripts/verify-backup.mjs` *(new)*

**What changed:**
Added a standalone verification script that:
1. Locates the most recent `.gz` backup archive (or accepts an explicit path via CLI argument).
2. Runs `mongorestore --dryRun` against it to confirm the archive is well-formed and parseable without writing any data.
3. Probes the extracted dump directory for required collections (`users`, `materials`, `purchases`).
4. Emits a structured JSON summary of all checks (pass/fail) to stdout.
5. Sends a failure alert email to `ADMIN_REPORT_EMAILS` if any check fails.
6. Deletes the temp extraction directory on exit regardless of outcome.

Exit code `0` = all checks passed. Exit code `1` = at least one check failed.

Intended to run automatically after each backup job:
```
node scripts/backup-mongodb.mjs && node scripts/verify-backup.mjs
```

---

## Environment Variables Added

| Variable | Used by | Purpose |
|---|---|---|
| `ADMIN_REPORT_EMAILS` | #363, #364 | Comma-separated admin email recipients |
| `SUPPORT_EMAIL` | #369 | Appeal contact address shown in suspension emails |

All existing `SMTP_*` / `EMAIL_*` variables are reused for email dispatch.

---

## Test Plan

- [ ] Upload a PDF with a `.pdf` extension but JPEG header bytes → expect HTTP 422
- [ ] Upload a valid PDF → passes validation and is pinned to Pinata
- [ ] Run `node scripts/weekly-admin-stats.mjs` with `MONGODB_URI` and `ADMIN_REPORT_EMAILS` set → confirm email received with correct stats
- [ ] `POST /api/admin/users/suspend` with `action: "suspend"` → user `status` becomes `"suspended"`, suspension email delivered
- [ ] `POST /api/admin/users/suspend` with `action: "reactivate"` → user `status` becomes `"active"`, reactivation email delivered
- [ ] Run `node scripts/verify-backup.mjs` against a valid `.gz` backup → exits 0 with PASSED summary
- [ ] Run `node scripts/verify-backup.mjs` against a corrupt archive → exits 1 and sends alert email

---

Closes #363, #364, #365, #369
