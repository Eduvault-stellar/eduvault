/**
 * Idempotency classification for external-boundary operations.
 *
 * Categories:
 *   - read                — safe to retry, no side effects
 *   - idempotent_write    — safe to retry (same result regardless of count)
 *   - non_idempotent_write — NOT safe to retry (duplicate causes side effects)
 */

/**
 * @typedef {'read' | 'idempotent_write' | 'non_idempotent_write'} OperationCategory
 */

/**
 * @type {Record<string, { category: OperationCategory, description: string }>}
 */
const CLASSIFICATIONS = {
  // ── MongoDB ──────────────────────────────────────────────────────────
  "mongodb.find": { category: "read", description: "Database query (no side effects)" },
  "mongodb.aggregate": { category: "read", description: "Database aggregation pipeline" },
  "mongodb.findOne": { category: "read", description: "Single document lookup" },
  "mongodb.insertOne": { category: "non_idempotent_write", description: "Document insert (duplicate creates duplicate docs)" },
  "mongodb.updateOne": { category: "idempotent_write", description: "Document update (same result if repeated)" },
  "mongodb.findOneAndUpdate": { category: "idempotent_write", description: "Atomic find-and-update" },
  "mongodb.replaceOne": { category: "idempotent_write", description: "Document replacement" },
  "mongodb.deleteOne": { category: "idempotent_write", description: "Document deletion (idempotent)" },
  "mongodb.bulkWrite": { category: "idempotent_write", description: "Bulk write (caller manages idempotency via ordered ops)" },
  "mongodb.insertOne.no-idempotency-key": { category: "non_idempotent_write", description: "Insert without idempotency key" },
  "mongodb.command": { category: "idempotent_write", description: "Database command (e.g. ping)" },

  // ── Stellar Horizon ──────────────────────────────────────────────────
  "stellar.loadAccount": { category: "read", description: "Horizon account lookup" },
  "stellar.feeStats": { category: "read", description: "Horizon fee statistics" },
  "stellar.submitTransaction": { category: "non_idempotent_write", description: "Transaction submission (same tx = duplicate on-chain)" },
  "stellar.root": { category: "read", description: "Horizon root endpoint (health)" },

  // ── Stellar RPC / Soroban ───────────────────────────────────────────
  "stellar.rpc.getEvents": { category: "read", description: "RPC event query" },
  "stellar.rpc.getHealth": { category: "read", description: "RPC health check" },
  "stellar.rpc.getLedgerEntries": { category: "read", description: "RPC ledger entry query" },
  "stellar.rpc.simulateTransaction": { category: "read", description: "RPC transaction simulation (read-only)" },
  "stellar.rpc.sendTransaction": { category: "non_idempotent_write", description: "RPC transaction submission" },

  // ── Pinata / IPFS ───────────────────────────────────────────────────
  "pinata.testAuthentication": { category: "read", description: "Pinata auth test" },
  "pinata.upload": { category: "idempotent_write", description: "Pinata file upload (CID-based dedup)" },
  "pinata.unpin": { category: "idempotent_write", description: "Pinata unpin (idempotent)" },
  "pinata.list": { category: "read", description: "Pinata file listing" },

  // ── Nodemailer / Email ──────────────────────────────────────────────
  "email.send": { category: "non_idempotent_write", description: "Send email (duplicate sends duplicate emails)" },
  "email.verify": { category: "read", description: "SMTP connection verification" },

  // ── Redis ────────────────────────────────────────────────────────────
  "redis.get": { category: "read", description: "Cache read" },
  "redis.set": { category: "idempotent_write", description: "Cache write (same key+value)" },
  "redis.del": { category: "idempotent_write", description: "Cache delete" },
  "redis.eval": { category: "idempotent_write", description: "Lua script execution (assumed idempotent)" },

  // ── Outbound Webhooks ───────────────────────────────────────────────
  "webhook.deliver": { category: "non_idempotent_write", description: "POST to external URL (duplicate = double notification)" },

  // ── Vercel Blob (reserved for future) ───────────────────────────────
  "blob.put": { category: "idempotent_write", description: "Blob upload (path-based, idempotent)" },
  "blob.delete": { category: "idempotent_write", description: "Blob delete" },
  "blob.list": { category: "read", description: "Blob listing" },
};

/**
 * Classify an operation by key.
 *
 * @param {string} key  — dot-separated e.g. "mongodb.findOne"
 * @returns {{ category: OperationCategory, description: string }}
 */
export function classifyOperation(key) {
  return CLASSIFICATIONS[key] || { category: "non_idempotent_write", description: `Unknown operation: ${key}. Defaulting to non-idempotent.` };
}

/**
 * Check whether an operation key is safe to retry.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isIdempotent(key) {
  const op = classifyOperation(key);
  return op.category === "read" || op.category === "idempotent_write";
}

/**
 * Return the full classification table (for inspection / testing).
 */
export function getClassificationTable() {
  return { ...CLASSIFICATIONS };
}
