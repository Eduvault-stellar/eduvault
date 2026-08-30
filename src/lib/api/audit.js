import { getContext } from "../telemetry/context.js";
import { redactFields } from "../telemetry/redact.js";

// Audit logs are deliberately allow-listed: unlike application logs, these
// records are retained for investigations and must never accidentally include
// request bodies, credentials, or raw uploaded content.
const SAFE_FIELDS = new Set([
  "event",
  "route",
  "method",
  "status",
  "reason",
  "actor",
  "walletAddress",
  "materialId",
  "cursor",
  "eventId",
  "outcome",
  "action",
  "resource",
  "uploadId",
  "source",
  "network",
  "ledger",
  "durationMs",
  "retryCount",
  "errorCode",
  "policyVersion",
  "approvalId",
  "emergencyId",
  "refundId",
  "purchaseId",
  "scope",
  "role",
]);

import crypto from "node:crypto";

export function canonicalJsonStringify(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJsonStringify).join(",") + "]";
  }
  const sortedKeys = Object.keys(obj).sort();
  const parts = sortedKeys.map(
    (key) => JSON.stringify(key) + ":" + canonicalJsonStringify(obj[key])
  );
  return "{" + parts.join(",") + "}";
}

export function computeRecordHash(entry, previousHash = "0".repeat(64)) {
  const canonical = canonicalJsonStringify(entry);
  return crypto.createHash("sha256").update(`${previousHash}:${canonical}`).digest("hex");
}

export function createAuditEntry(fields = {}, previousHash = null) {
  const context = getContext();
  const entry = {
    timestamp: new Date().toISOString(),
    correlationId: context?.correlationId,
    traceId: context?.traceId,
    route: context?.route,
    jobType: context?.jobType,
  };

  for (const [key, value] of Object.entries(redactFields(fields))) {
    if (SAFE_FIELDS.has(key) && value !== undefined && value !== null) {
      entry[key] = String(value).slice(0, 300);
    }
  }

  const cleanEntry = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined && value !== null)
  );

  if (previousHash !== null) {
    const prev = previousHash || "0".repeat(64);
    cleanEntry.previousHash = prev;
    cleanEntry.hash = computeRecordHash(cleanEntry, prev);
  }

  return cleanEntry;
}

export function auditLog(fields, previousHash = null) {
  const entry = createAuditEntry(fields, previousHash);
  console.info(JSON.stringify(entry));
  return entry;
}

