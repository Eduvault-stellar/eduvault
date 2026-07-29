# Payout Milestone Migration Runbook

## Overview

Migration **#5 (`normalize-payout-milestones`)** enhances the existing flat
`milestones` collection with a full document model and adds supporting
collections for evidence and transition history.  It also backfills any legacy
milestone data still embedded as a JSON array on `payouts` documents.

The migration runs in three stages:

| Stage | What it does | Can be re-run? |
|-------|-------------|----------------|
| **Expand** | Creates `milestone_evidence` and `milestone_history` collections; applies validators and indexes to `milestones` and the new collections. | Yes (idempotent) |
| **Backfill** | Scans existing `milestones` documents and `payouts.milestones` arrays and writes normalised documents to the enhanced `milestones` collection. | Yes (resumable via checkpoint) |
| **Verify** | Counts and sum-checks normalised vs legacy milestone records. Fails loudly on mismatch. | Yes (stateless) |

## Prerequisites

- Access to a MongoDB shell (`mongosh`) or Compass for manual verification.
- The `MIGRATION_BACKFILL_BATCH_SIZE` env var (default 100) to control per-checkpoint batch size.
- Sufficient database connection pool for the migration's background scan.

## Running the Migration

### 1. Expand (no data changes)

```bash
node scripts/migrations/migrate-db.mjs --target=5
```

On first run the migration's `up()` function executes **Expand**, then
**Backfill**, then **Verify**.  To stop after Expand only, use `--target=4`
(which runs migrations 1–4 but not 5), then later run `--target=5` to
trigger stage 5 only.

### 2. Backfill (data migration)

The Backfill stage is **resumable** — if the process crashes partway through,
re-running the migration picks up from the last checkpoint saved in the
`_schema_migrations` document for version 5.

**Monitoring progress:**

```javascript
// In mongosh:
use eduvault;
db._schema_migrations.findOne({ version: 5 }, { checkpoint: 1 });
```

The checkpoint field contains:

```json
{
  "phase": "backfill",
  "backfilled": 1423,
  "skipped": 2,
  "errors": [{ "id": "...", "reason": "...", "collection": "payouts" }],
  "processedIds": ["id1", "id2", ...],
  "updatedAt": "2026-07-29T..."
}
```

If `errors` is non-empty, inspect each entry in the database and decide
whether to:
- Fix the source data and re-run (the migration skips already-processed IDs).
- Manually insert the normalised milestone document.

### 3. Verify (consistency check)

Runs automatically after Backfill completes.  Fails with a `Verification FAILED`
message if:

- **Count mismatch**: normalised milestone count < legacy embedded count.
- **Total mismatch**: sum of `amount` fields differs between normalised and
  legacy collections (only checked when legacy totals are non-zero).

The verify stage is **stateless** and can be re-run at any time by adjusting
the checkpoint, or by calling `stageVerify()` directly from a script.

## Rollback

### Mid-Expand (safe)

If the migration crashes during the Expand stage, no data has been changed.
Simply re-run.

### Mid-Backfill (safe, resumable)

If the migration crashes during Backfill:

1. Confirm the checkpoint was saved by checking `_schema_migrations`.
2. Fix any data issues reported in `checkpoint.errors`.
3. **Re-run the migration** — it resumes from the checkpoint.

To roll back changes made by a partial backfill:

```bash
# 1. Drop new collections
mongosh eduvault --eval 'db.milestone_evidence.drop(); db.milestone_history.drop();'
# 2. Remove enhanced indexes from milestones
mongosh eduvault --eval '
  db.milestones.dropIndex("milestones_payout_id");
  db.milestones.dropIndex("milestones_payout_order_unique");
  db.milestones.dropIndex("milestones_status_payout");
'
# 3. Reset migration status for version 5:
db._schema_migrations.deleteOne({ version: 5 });
```

### Full Rollback (after successful migration)

The `down()` function of migration 005 removes:
- The `milestone_evidence` and `milestone_history` collections.
- The enhanced indexes on `milestones`.

To roll back:

```bash
# Manually run the down logic (the migration runner does not support
# automatic down migrations from the CLI).  Use mongosh:
mongosh eduvault --eval '
  db.milestone_evidence.drop();
  db.milestone_history.drop();
  db.milestones.dropIndex("milestones_payout_id");
  db.milestones.dropIndex("milestones_payout_order_unique");
  db.milestones.dropIndex("milestones_status_payout");
'
# Remove the migration record so it can be re-applied:
db._schema_migrations.deleteOne({ version: 5 });
```

### Data Reversal (restore legacy embedded milestones)

If you need to restore the legacy `milestones` array on payout documents from
the normalised collection:

```javascript
const milestones = db.milestones.find({ payoutId: { $exists: true } }).toArray();
const byPayout = {};
for (const m of milestones) {
  if (!byPayout[m.payoutId]) byPayout[m.payoutId] = [];
  byPayout[m.payoutId].push({
    milestoneId: m.milestoneId,
    order: m.order,
    title: m.title,
    description: m.description,
    amount: m.amount,
    status: m.status,
  });
}
for (const [payoutId, ms] of Object.entries(byPayout)) {
  db.payouts.updateOne({ payoutId }, { $set: { milestones: ms } });
}
```

## Dual-Read / Dual-Write Strategy

**Design choice: dual-read, not dual-write.**

The `milestoneService.js` layer:
- **Reads** from the normalised `milestones` collection first; falls back to
  the legacy `payouts.milestones` embedded array if no normalised records exist.
- **Writes** to the normalised `milestones` collection and **also syncs** the
  legacy `payouts.milestones` field so readers still using the old path see
  current data.

This makes the rollout:
- **Reversible** at any point (downgraded code sees the legacy field).
- **Safe for partial deployment** (some instances can run new code, others old).

## Contract Phase (remove legacy field)

After the migration has been verified in production for at least one release
cycle, a follow-up migration (e.g. version 6) should:

1. Confirm all milestones are in the normalised collection (count check).
2. `$unset` the `milestones` field from every `payouts` document.
3. Remove the legacy fallback paths from `milestoneService.js`.
4. Update the `payouts` validator in `schemaContracts.js` to no longer allow
   the `milestones` field.

This follow-up migration is intentionally **not** included in version 5 so that
deployment can be paused or reverted at any point without data loss.

## Monitoring & Alerts

- Check `_schema_migrations` for `{ version: 5, status: "failed" }`.
- Alert on `checkpoint.errors` length > 0.
- After Verify, confirm `checkpoint` is deleted (means all stages completed).

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `E11000 duplicate key` during backfill | Two workers running concurrently | Re-run; the migration skips already-processed IDs |
| `Verification FAILED` | Count or total mismatch | Inspect checkpoint.errors; fix source data; re-run |
| Migration lock held | Another process has the lock | Wait 60s for expiry, or kill the other process |
