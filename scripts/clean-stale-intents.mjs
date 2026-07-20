/**
 * Garbage collector — stale checkout intents
 *
 * Removes `checkout_intents` documents that have been in `pending` status for
 * longer than STALE_THRESHOLD_HOURS without being confirmed or cancelled.
 * Records in any other status (confirmed, cancelled, failed) are left untouched.
 *
 * Usage:
 *   node scripts/clean-stale-intents.mjs
 *
 * Environment variables:
 *   MONGODB_URI   — required; MongoDB connection string
 *   MONGODB_DB    — optional; database name (default: "eduvault")
 *   DRY_RUN       — optional; set to "true" to log matches without deleting
 *   STALE_HOURS   — optional; hours before a pending intent is considered stale (default: 2)
 */

import { MongoClient } from "mongodb";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";
const DRY_RUN = process.env.DRY_RUN === "true";
const STALE_HOURS = Number(process.env.STALE_HOURS ?? "2");
const COLLECTION = "checkout_intents";

if (!MONGODB_URI) {
  console.error("[clean-stale-intents] MONGODB_URI is not set. Aborting.");
  process.exit(1);
}

if (!Number.isFinite(STALE_HOURS) || STALE_HOURS <= 0) {
  console.error(`[clean-stale-intents] Invalid STALE_HOURS value: "${process.env.STALE_HOURS}". Must be a positive number.`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function staleThresholdDate(hoursAgo = STALE_HOURS) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
}

function buildQuery(cutoff) {
  return {
    status: "pending",
    createdAt: { $lt: cutoff },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const label = DRY_RUN ? "[DRY RUN] " : "";
  console.log(`[clean-stale-intents] ${label}Starting. Stale threshold: ${STALE_HOURS}h`);

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const collection = db.collection(COLLECTION);

    const cutoff = staleThresholdDate();
    const query = buildQuery(cutoff);

    console.log(`[clean-stale-intents] Cutoff timestamp: ${cutoff.toISOString()}`);

    // Count matches first so we can log them regardless of dry-run mode
    const matchCount = await collection.countDocuments(query);
    console.log(`[clean-stale-intents] ${label}Found ${matchCount} stale pending intent(s) to remove.`);

    if (matchCount === 0) {
      console.log("[clean-stale-intents] Nothing to clean up.");
      return;
    }

    if (DRY_RUN) {
      const samples = await collection.find(query, { projection: { _id: 1, createdAt: 1, userId: 1 } }).limit(5).toArray();
      console.log("[clean-stale-intents] Sample matches (up to 5):", JSON.stringify(samples, null, 2));
      console.log("[clean-stale-intents] DRY_RUN=true — no documents were deleted.");
      return;
    }

    const result = await collection.deleteMany(query);
    console.log(`[clean-stale-intents] Deleted ${result.deletedCount} stale intent(s).`);

    if (result.deletedCount !== matchCount) {
      console.warn(
        `[clean-stale-intents] Warning: expected to delete ${matchCount} but deleted ${result.deletedCount}. ` +
        "Some documents may have been modified between the count and delete operations.",
      );
    }
  } finally {
    await client.close();
    console.log("[clean-stale-intents] Done.");
  }
}

run().catch((err) => {
  console.error("[clean-stale-intents] Fatal error:", err);
  process.exit(1);
});
