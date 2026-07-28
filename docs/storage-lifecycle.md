# Storage lifecycle and incident cleanup

Reference for the authorized file lifecycle introduced in #98. Covers the
metadata model, the authorization boundary, the deletion/cleanup flow, and the
operator runbooks for orphan detection and incident cleanup.

## Metadata model

Every stored object has a row in the `files` collection
(`src/lib/uploads/fileLifecycle.js`) linking it to:

| Field | Meaning |
| --- | --- |
| `ownerId` | wallet/user identity that owns the object |
| `purpose` | one of `FILE_PURPOSES` (avatar, material, milestone_evidence, payout_document, feedback_attachment) |
| `visibility` | `public` or `private`, derived from the purpose |
| `parentType` / `parentId` | the entity the file belongs to (a user, a material, a milestone) |
| `mimeType`, `size`, `checksum` | content descriptors; checksum is sha256 |
| `storageKey` | backend object identifier (the IPFS CID, or a derived key) |
| `state` | `pending` → `active` → `pending_deletion` → `deleted` |

Each purpose declares its own **visibility** and **byte limit**, which is how
"public avatars and private evidence use separate policies" is enforced: the
policy lives in `FILE_PURPOSES`, not at the call site.

## Authorization boundary

`getFileForRequester(db, storageKey, requesterId)`:

- **public** objects (avatars) are readable by anyone;
- **private** objects (evidence, payout files) are readable only by their
  owner. A non-owner receives `FileNotFoundError` (HTTP 404), never a 403, so
  the existence of another tenant's private object is not leaked.

`deleteFile` and `replaceFile` are owner-scoped: a requester who is not the
owner gets `FileAuthorizationError` (403) and the object is untouched.

HTTP surface: `GET|DELETE /api/files/<storage-key>`
(`src/app/api/files/[...key]/route.js`).

## Content validation

`assertValidFileInput` rejects, before anything is written:

- files over their purpose's byte limit;
- a declared checksum that does not match the actual bytes (spoofing);
- a declared size that does not match the actual bytes.

This is content verification, not extension/MIME trust. It complements the
existing magic-byte check in `src/lib/ipfs/uploadValidator.js` and the
quarantine scanner in `src/lib/uploads/quarantine.js`.

## Deletion is transactional, so a DB failure never orphans storage

Deletion and replacement are two-phase:

1. The `files` row is moved to `pending_deletion` **and** a task is written to
   the `file_cleanup_outbox` — in one transaction when the driver supports it.
2. The cleanup worker later removes the backend object and tombstones the row.

The outbox is the durable source of truth. If the process dies after step 1,
the object is still guaranteed to be cleaned up on the next worker pass. If the
backend removal fails, the task is retried with capped exponential backoff and
marked `failed` only after `maxAttempts`, so a transient storage outage never
loses the deletion and never tombstones a record whose bytes still exist.

Replacement retires the old object before inserting the new one, because the
`files_parent_active_unique` index permits only one active file per parent.

## Runbooks

### Routine cleanup (drain the outbox)

Run on a schedule (cron or a worker loop):

```bash
npm run files:cleanup
```

Emits `file_cleanup_complete` with `{ scanned, removed, failed }`. A non-zero
`failed` count with tasks stuck in `failed` status means the storage backend
rejected removals past the retry ceiling — investigate credentials/backend
health, fix, then reset those tasks to `pending`.

### Orphan detection

An orphan is a backend object with no live `files` record (e.g. an upload that
crashed after pinning but before the metadata write). Detect them without
changing anything:

```bash
npm run files:orphans
```

Emits `file_orphan_scan_complete` with counts. When the report looks right,
enqueue the orphans for cleanup:

```bash
npm run files:orphans:apply
```

Then run `npm run files:cleanup` to actually remove them. The two-step
dry-run → apply split exists so a bad `listStorageKeys` adapter can never
delete live data on the first run.

### Incident cleanup (a bad object must be purged now)

1. Identify the object's storage key (CID).
2. `DELETE /api/files/<storage-key>` as the owner, or, for an operator action,
   insert a `pending` task directly into `file_cleanup_outbox` keyed on the
   storage key.
3. Run `npm run files:cleanup` to remove it immediately rather than waiting for
   the scheduled pass.
4. Confirm the `files` row is `deleted` and the outbox task is gone.

## Deferred / follow-up

- **Signed upload/download URLs and the storage-backend choice** (keep private
  objects on IPFS behind gated delivery, or move to object storage with signed
  URLs) are intentionally not decided here. The model is backend-agnostic —
  the remove/list adapters are injected — so that decision can be made without
  reshaping it.
- **Migrating the existing `/api/upload` route** onto this model (so uploads
  register a `files` row and reuse the dedupe/quarantine path) is the natural
  next step once the backend question is settled.
