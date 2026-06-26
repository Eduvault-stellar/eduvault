#!/usr/bin/env node
/**
 * Backup restore verification for EduVault (#377).
 *
 * Validates a mongodump archive before it is applied to a production database:
 *  1. Confirms the archive is well-formed with a mongorestore dry-run.
 *  2. Connects to MongoDB, reads every document in each known collection,
 *     and checks that required fields are present.
 *  3. Prints a structured JSON status report and exits 1 if any schema
 *     violations are found, blocking downstream restore steps.
 *
 * Typical workflow:
 *   mongorestore --archive=backup.gz --gzip --uri=$STAGING_URI
 *   MONGODB_URI=$STAGING_URI node scripts/restore-verification.mjs backup.gz
 *   # only restore to production after this script exits 0
 *
 * Usage:
 *   node scripts/restore-verification.mjs <path-to-archive.gz>
 *
 * Required env vars:
 *   MONGODB_URI  — connection string for the database to validate
 *
 * Optional env vars:
 *   MONGODB_DB   — database name to validate (default: eduvault)
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Structured logger (matches backup-mongodb.mjs convention)
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Validate required environment variables
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    log("error", `Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const MONGODB_URI = requireEnv("MONGODB_URI");
const DB_NAME = process.env.MONGODB_DB || "eduvault";
const archivePath = process.argv[2];

// ---------------------------------------------------------------------------
// Required fields per collection — documents missing any of these are flagged
// as schema violations and block the restore.
// ---------------------------------------------------------------------------
const COLLECTION_SCHEMAS = {
  materials: ["_id", "title", "userAddress", "visibility", "createdAt"],
  users: ["_id", "walletAddress"],
  purchases: ["_id", "buyerAddress", "materialId", "createdAt"],
  entitlement_cache: ["_id", "buyerAddress", "materialId", "active"],
  sync_state: ["_id", "source"],
  sync_events: ["_id"],
  dead_letter_events: ["_id", "status"],
  material_history: ["_id", "materialId"],
  saved_materials: ["_id", "walletAddress", "materialId"],
};

// ---------------------------------------------------------------------------
// Step 1: Validate archive structure via mongorestore dry-run
// ---------------------------------------------------------------------------
async function validateArchiveStructure(archive) {
  if (!existsSync(archive)) {
    log("error", "Archive file not found", { path: archive });
    process.exit(1);
  }

  log("info", "Checking archive structure (mongorestore --dryRun)", { archive });
  try {
    const { stderr } = await execFileAsync("mongorestore", [
      `--archive=${archive}`,
      "--gzip",
      "--dryRun",
    ]);
    if (stderr) log("debug", "mongorestore output", { stderr });
    log("info", "Archive structure valid");
  } catch (err) {
    log("error", "Archive structure invalid — restore blocked", { error: err.message });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Validate document schemas against known collection contracts
// ---------------------------------------------------------------------------
async function validateCollectionSchemas(mongoClient) {
  const db = mongoClient.db(DB_NAME);
  const report = {
    database: DB_NAME,
    collections: {},
    totalDocuments: 0,
    totalViolations: 0,
  };

  for (const [collectionName, requiredFields] of Object.entries(COLLECTION_SCHEMAS)) {
    const collection = db.collection(collectionName);
    let count = 0;
    let violations = 0;
    const violationSamples = [];

    const cursor = collection.find({});
    for await (const doc of cursor) {
      count++;
      const missing = requiredFields.filter((field) => !(field in doc));
      if (missing.length > 0) {
        violations++;
        if (violationSamples.length < 5) {
          violationSamples.push({ _id: String(doc._id), missingFields: missing });
        }
      }
    }
    await cursor.close();

    report.collections[collectionName] = {
      documents: count,
      violations,
      ...(violationSamples.length > 0 ? { violationSamples } : {}),
    };
    report.totalDocuments += count;
    report.totalViolations += violations;

    if (violations > 0) {
      log("warn", "Schema violations detected", {
        collection: collectionName,
        violations,
        samples: violationSamples,
      });
    } else {
      log("info", "Collection schema OK", { collection: collectionName, documents: count });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  if (!archivePath) {
    log("error", "No archive path provided. Usage: node scripts/restore-verification.mjs <archive.gz>");
    process.exit(1);
  }

  log("info", "EduVault restore verification started", { archive: archivePath, db: DB_NAME });

  await validateArchiveStructure(archivePath);

  const mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  let report;
  try {
    await mongoClient.connect();
    log("info", "Connected to MongoDB for schema validation");
    report = await validateCollectionSchemas(mongoClient);
  } finally {
    await mongoClient.close();
  }

  log("info", "Verification summary", report);

  if (report.totalViolations > 0) {
    log("error", "Schema violations found — restore blocked", {
      totalViolations: report.totalViolations,
      totalDocuments: report.totalDocuments,
    });
    process.exit(1);
  }

  log("info", "All schema checks passed. Safe to proceed with restore.", {
    totalDocuments: report.totalDocuments,
  });
})();
