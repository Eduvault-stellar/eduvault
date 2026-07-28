import { getDb } from "../src/lib/mongodb.js";
import { runFileCleanup, detectOrphans } from "../src/lib/uploads/fileLifecycle.js";

/**
 * File cleanup + orphan-detection runner (#98).
 *
 * Modes:
 *   (default)          drain the cleanup outbox: unpin each pending object and
 *                      tombstone its record.
 *   orphans            report storage objects with no live record (dry run).
 *   orphans:apply      enqueue those orphans for cleanup.
 *
 * The storage remove adapter is built here so provider credentials never leave
 * the server. `storageKey` is the backend object identifier — for IPFS that is
 * the CID, which is what the upload path stores as the key.
 */

const runMode = process.argv[2] || "cleanup";

async function pinataUnpin() {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error("PINATA_JWT is required to unpin objects during cleanup");
  }
  const { PinataSDK } = await import("pinata");
  const pinata = new PinataSDK({ pinataJwt: jwt });
  return async (storageKey) => {
    // Treat the storage key as the CID. unpin throwing keeps the outbox task
    // pending for a bounded retry rather than tombstoning prematurely.
    await pinata.unpin([storageKey]);
  };
}

/** Lists CIDs currently pinned, for orphan detection. */
async function pinataListKeys() {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is required to list objects for orphan detection");
  const { PinataSDK } = await import("pinata");
  const pinata = new PinataSDK({ pinataJwt: jwt });
  const keys = [];
  let pageToken;
  do {
    const page = await pinata.files.public.list().limit(1000).pageToken(pageToken);
    for (const file of page.files || []) keys.push(file.cid);
    pageToken = page.next_page_token;
  } while (pageToken);
  return keys;
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}

const db = await getDb();

if (runMode === "orphans" || runMode === "orphans:apply") {
  const mode = runMode === "orphans:apply" ? "apply" : "dryRun";
  const report = await detectOrphans(db, pinataListKeys, { mode });
  emit({
    event: "file_orphan_scan_complete",
    mode,
    orphanedStorageObjects: report.orphanedStorageKeys.length,
    stuckRecords: report.stuckRecordKeys.length,
    enqueued: report.enqueued,
  });
} else {
  const remove = await pinataUnpin();
  const result = await runFileCleanup(db, remove, {
    limit: Number(process.env.FILE_CLEANUP_LIMIT || 100),
  });
  emit({ event: "file_cleanup_complete", ...result, failed: result.failed.length });
}
