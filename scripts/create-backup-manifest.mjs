#!/usr/bin/env node
/**
 * Creates a versioned, integrity-checked backup manifest for EduVault.
 *
 * What it does:
 *  1. Gathers metadata about the current application state:
 *     - Git commit hash and version
 *     - MongoDB database name and collection details
 *     - Soroban contract IDs and network passphrase
 *     - IPFS/Pinata pinned object inventory
 *  2. Generates a JSON manifest file.
 *  3. (Future) Signs and encrypts the manifest.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import PinataSDK from "@pinata/sdk";
import { MongoClient } from "mongodb";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Get IPFS pinned files from Pinata
// ---------------------------------------------------------------------------
async function getPinataPinnedObjects() {
  if (!process.env.PINATA_JWT) {
    log("warn", "PINATA_JWT not set - skipping Pinata inventory");
    return [];
  }

  const pinata = new PinataSDK({ pinataJWTKey: process.env.PINATA_JWT });
  const pins = [];
  let page = 0;
  let hasMore = true;

  log("info", "Fetching pinned objects from Pinata");

  while (hasMore) {
    try {
      const result = await pinata.pinList({
        pageLimit: 100,
        pageOffset: page * 100,
        status: "pinned",
      });

      pins.push(...result.rows);
      hasMore = result.rows.length > 0;
      page++;
    } catch (err) {
      log("error", "Failed to fetch pinned objects from Pinata", { error: err.message });
      hasMore = false;
    }
  }

  log("info", `Fetched ${pins.length} pinned objects from Pinata`);
  return pins.map(pin => ({
    cid: pin.ipfs_pin_hash,
    name: pin.metadata?.name || "unnamed",
    size: pin.size,
    createdAt: pin.date_pinned,
  }));
}

// ---------------------------------------------------------------------------
// Get MongoDB collection details
// ---------------------------------------------------------------------------
async function getMongoDbCollectionDetails() {
  if (!process.env.MONGODB_URI) {
    log("warn", "MONGODB_URI not set - skipping MongoDB inventory");
    return {};
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "eduvault");
    const collections = await db.listCollections().toArray();
    const details = {};

    for (const collection of collections) {
      const name = collection.name;
      const count = await db.collection(name).countDocuments();
      const stats = await db.command({ collStats: name });
      details[name] = {
        count,
        size: stats.size,
        storageSize: stats.storageSize,
        avgObjSize: stats.avgObjSize,
      };
    }

    return details;
  } catch (err) {
    log("error", "Failed to get MongoDB collection details", { error: err.message });
    return {};
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function createManifest() {
  log("info", "Creating backup manifest");

  const manifest = {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    application: {},
    database: {},
    contracts: {},
    ipfs: {},
  };

  // --- Application ---
  try {
    const { stdout: gitHash } = await execFileAsync("git", ["rev-parse", "HEAD"]);
    const { stdout: gitBranch } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    manifest.application.gitHash = gitHash.trim();
    manifest.application.gitBranch = gitBranch.trim();
  } catch (err) {
    log("warn", "Could not determine git version", { error: err.message });
  }

  // --- Database (MongoDB) ---
  manifest.database.name = process.env.MONGODB_DB || "eduvault";
  manifest.database.collections = await getMongoDbCollectionDetails();

  // --- Contracts (Soroban) ---
  manifest.contracts.networkPassphrase = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || null;
  manifest.contracts.materialRegistryContractId = process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID || null;
  manifest.contracts.purchaseManagerContractId = process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID || null;

  // --- IPFS (Pinata) ---
  manifest.ipfs.pinnedObjects = await getPinataPinnedObjects();

  const manifestJson = JSON.stringify(manifest, null, 2);
  console.log(manifestJson);

  log("info", "Backup manifest created");
}

(async () => {
  try {
    await createManifest();
  } catch (err) {
    log("error", "Failed to create backup manifest", { error: err.message });
    process.exit(1);
  }
})();
