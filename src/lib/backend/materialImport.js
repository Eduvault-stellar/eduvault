import { createHash, randomUUID } from "node:crypto";

import { sanitizeString, normalizeStringList, normalizeImageField } from "../api/validation.js";
import {
  normalizeSubject,
  normalizeCategory,
  normalizeLevel,
} from "./taxonomy.js";

const REQUIRED_FIELDS = ["title", "storageKey"];
const OPTIONAL_FIELDS = [
  "description", "shortSummary", "price", "usageRights", "visibility",
  "coverImageUrl", "thumbnailUrl", "category", "subject", "level",
  "learningOutcomes", "tableOfContents", "sampleNotes",
];

const SUPPORTED_FORMATS = ["csv", "json"];

export class ImportValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ImportValidationError";
    this.details = details;
  }
}

export class ImportConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ImportConflictError";
    this.details = details;
  }
}

const IMPORT_JOBS = "material_import_jobs";
const IMPORT_ROWS = "material_import_rows";
const MATERIALS = "materials";
const ROW_LEASE_MS = 60_000;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function duplicateKey(error) {
  return error?.code === 11000 || error?.codeName === "DuplicateKey";
}

export function normalizeImportId(value) {
  const importId = sanitizeString(value, { maxLength: 128 });
  if (!importId || !/^[a-zA-Z0-9._:-]+$/.test(importId)) {
    throw new ImportValidationError(
      "A stable importId (or Idempotency-Key header) is required to publish",
      { field: "importId" },
    );
  }
  return importId;
}

export function validateImportSchema(body) {
  const format = sanitizeString(body?.format, { maxLength: 10 }) || "json";
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new ImportValidationError(`Unsupported import format: "${format}". Supported: ${SUPPORTED_FORMATS.join(", ")}`, { field: "format" });
  }

  const dryRun = body?.dryRun !== false;

  let records;
  if (body?.records && Array.isArray(body.records)) {
    records = body.records;
  } else if (body?.items && Array.isArray(body.items)) {
    records = body.items;
  } else {
    throw new ImportValidationError("Import payload must contain a 'records' or 'items' array");
  }

  if (records.length === 0) {
    throw new ImportValidationError("Import payload contains no records");
  }

  if (records.length > 500) {
    throw new ImportValidationError("Maximum 500 records per import", { maxRecords: 500, received: records.length });
  }

  return { format, dryRun, records };
}

export function validateImportRow(row, index) {
  const errors = [];
  const images = {};

  for (const [field, value] of [
    ["coverImageUrl", row?.coverImageUrl],
    ["thumbnailUrl", row?.thumbnailUrl],
  ]) {
    try {
      images[field] = normalizeImageField(value, field);
    } catch (error) {
      errors.push({ field, message: error.message });
    }
  }

  const title = sanitizeString(row?.title, { maxLength: 160 });
  if (!title) {
    errors.push({ field: "title", message: "Title is required" });
  }

  const storageKey = sanitizeString(row?.storageKey || row?.fileUrl, { maxLength: 2048 });
  if (!storageKey) {
    errors.push({ field: "storageKey", message: "storageKey or fileUrl is required" });
  }

  let price = 0;
  if (row?.price !== undefined && row?.price !== null && row?.price !== "") {
    price = Number(row.price);
    if (!Number.isFinite(price) || price < 0) {
      errors.push({ field: "price", message: `Invalid price: "${row.price}"` });
    }
  }

  let visibility = sanitizeString(row?.visibility, { maxLength: 20 }) || "private";
  if (!["private", "public", "unlisted"].includes(visibility)) {
    errors.push({ field: "visibility", message: `Invalid visibility: "${visibility}". Must be private, public, or unlisted` });
  }

  let category = null;
  if (row?.category) {
    const normalized = normalizeCategory(row.category);
    if (!normalized) {
      errors.push({ field: "category", message: `Unknown category: "${row.category}"` });
    } else {
      category = normalized.id;
    }
  }

  let subject = null;
  if (row?.subject) {
    const normalized = normalizeSubject(row.subject);
    if (!normalized) {
      errors.push({ field: "subject", message: `Unknown subject: "${row.subject}"` });
    } else {
      subject = normalized.id;
      if (!category) category = normalized.categoryId;
    }
  }

  let level = null;
  if (row?.level) {
    const normalized = normalizeLevel(row.level);
    if (!normalized) {
      errors.push({ field: "level", message: `Unknown level: "${row.level}"` });
    } else {
      level = normalized.id;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, row: index + 1 };
  }

  const data = {
    title,
    description: sanitizeString(row?.description, { maxLength: 5000 }) || "",
    shortSummary: sanitizeString(row?.shortSummary, { maxLength: 280 }) || "",
    price,
    usageRights: sanitizeString(row?.usageRights, { maxLength: 1000 }) || "",
    visibility,
    ...images,
    category,
    subject,
    level,
    learningOutcomes: normalizeStringList(row?.learningOutcomes, { maxItems: 8, maxLength: 180 }),
    tableOfContents: normalizeStringList(row?.tableOfContents, { maxItems: 16, maxLength: 180 }),
    sampleNotes: normalizeStringList(row?.sampleNotes, { maxItems: 6, maxLength: 280 }),
    storageKey,
    fileUrl: storageKey,
  };
  const suppliedRecordId = sanitizeString(row?.recordId, { maxLength: 128 });
  if (suppliedRecordId && !/^[a-zA-Z0-9._:-]+$/.test(suppliedRecordId)) {
    return {
      valid: false,
      errors: [{ field: "recordId", message: "recordId contains unsupported characters" }],
      row: index + 1,
    };
  }

  return {
    valid: true,
    data: {
      ...data,
      recordId: suppliedRecordId || `row-${index + 1}-${digest(stableJson(data)).slice(0, 16)}`,
    },
    row: index + 1,
  };
}

export function validateImportPayload(body) {
  const { format, dryRun, records } = validateImportSchema(body);

  const results = records.map((row, index) => validateImportRow(row, index));

  const invalidRows = results.filter((r) => !r.valid).map((r) => ({
    row: r.row,
    errors: r.errors,
  }));
  const validRecords = [];
  const seenRecordIds = new Set();
  for (const result of results.filter((entry) => entry.valid)) {
    if (seenRecordIds.has(result.data.recordId)) {
      invalidRows.push({
        row: result.row,
        errors: [{ field: "recordId", message: "recordId must be unique within an import" }],
      });
      continue;
    }
    seenRecordIds.add(result.data.recordId);
    validRecords.push(result.data);
  }

  return {
    format,
    dryRun,
    total: records.length,
    valid: validRecords.length,
    invalid: invalidRows.length,
    validRecords,
    invalidRows,
  };
}

export function materialImportKey({ ownerId, importId, recordId }) {
  return digest(`${ownerId}\0${importId}\0${recordId}`);
}

export async function ensureMaterialImportIndexes(db) {
  await Promise.all([
    db.collection(IMPORT_JOBS).createIndex(
      { ownerId: 1, importId: 1 },
      { name: "material_import_owner_id_unique", unique: true },
    ),
    db.collection(IMPORT_ROWS).createIndex(
      { ownerId: 1, importId: 1, recordId: 1 },
      { name: "material_import_row_unique", unique: true },
    ),
    db.collection(IMPORT_ROWS).createIndex(
      { status: 1, leaseUntil: 1 },
      { name: "material_import_row_lease" },
    ),
    db.collection(MATERIALS).createIndex(
      { importKey: 1 },
      { name: "materials_import_key_unique", unique: true, sparse: true },
    ),
  ]);
}

function recordHashes(records) {
  return records.map(({ recordId, ...material }) => ({
    recordId,
    payloadHash: digest(stableJson(material)),
  }));
}

function manifestHash(records) {
  return digest(stableJson(recordHashes(records).sort((a, b) => a.recordId.localeCompare(b.recordId))));
}

async function ensureImportJob(db, { ownerId, importId, records, now }) {
  const jobs = db.collection(IMPORT_JOBS);
  const hash = manifestHash(records);
  try {
    await jobs.updateOne(
      { ownerId, importId },
      {
        $setOnInsert: {
          ownerId,
          importId,
          manifestHash: hash,
          total: records.length,
          status: "pending",
          createdAt: now,
        },
        $set: { lastAttemptAt: now, updatedAt: now },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }

  const job = await jobs.findOne({ ownerId, importId });
  if (!job || job.manifestHash !== hash) {
    throw new ImportConflictError(
      "This importId was already used with a different set of records",
      { importId },
    );
  }
  return job;
}

async function ensureImportRow(db, { ownerId, importId, recordId, payloadHash, now }) {
  const rows = db.collection(IMPORT_ROWS);
  try {
    await rows.updateOne(
      { ownerId, importId, recordId },
      {
        $setOnInsert: {
          ownerId,
          importId,
          recordId,
          payloadHash,
          status: "pending",
          attempts: 0,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
  }

  const row = await rows.findOne({ ownerId, importId, recordId });
  if (row?.payloadHash !== payloadHash) {
    throw new ImportConflictError("A recordId was reused with different material data", { recordId });
  }
  return row;
}

async function publishImportRow(db, { ownerId, userAddress, importId, record, now }) {
  const { recordId, ...material } = record;
  const payloadHash = digest(stableJson(material));
  const rowFilter = { ownerId, importId, recordId };
  const existing = await ensureImportRow(db, { ...rowFilter, payloadHash, now });
  if (existing.status === "complete") {
    return { recordId, status: "complete", materialId: existing.materialId, reused: true };
  }

  const processingToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + ROW_LEASE_MS);
  const claimed = await db.collection(IMPORT_ROWS).findOneAndUpdate(
    {
      ...rowFilter,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "processing", leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: "processing", processingToken, leaseUntil, updatedAt: now },
      $inc: { attempts: 1 },
      $unset: { lastError: "" },
    },
    { returnDocument: "after" },
  );
  if (!claimed) {
    return { recordId, status: "processing", retryAfterMs: ROW_LEASE_MS };
  }

  const importKey = materialImportKey({ ownerId, importId, recordId });
  try {
    let write;
    try {
      write = await db.collection(MATERIALS).updateOne(
        { importKey },
        {
          $setOnInsert: {
            ...material,
            userAddress,
            importKey,
            importedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }

    const saved = await db.collection(MATERIALS).findOne(
      { importKey },
      { projection: { _id: 1 } },
    );
    if (!saved) throw new Error("Material write could not be confirmed");

    await db.collection(IMPORT_ROWS).updateOne(
      { ...rowFilter, status: "processing", processingToken },
      {
        $set: { status: "complete", materialId: saved._id, completedAt: now, updatedAt: now },
        $unset: { processingToken: "", leaseUntil: "", lastError: "" },
      },
    );
    return {
      recordId,
      status: "complete",
      materialId: saved._id,
      reused: write?.upsertedCount !== 1,
    };
  } catch (error) {
    const errorCode = String(error?.codeName || error?.code || error?.name || "unknown")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 80);
    const message = `material_write_failed:${errorCode || "unknown"}`;
    await db.collection(IMPORT_ROWS).updateOne(
      { ...rowFilter, status: "processing", processingToken },
      {
        $set: { status: "failed", lastError: message, updatedAt: now },
        $unset: { processingToken: "", leaseUntil: "" },
      },
    );
    return { recordId, status: "failed", error: "Material publication failed; retry this record" };
  }
}

/**
 * Publishes rows one at a time behind durable row leases. Materials carry a
 * unique importKey, so a retry after a disconnect or a crash between the
 * material write and progress update observes the prior write instead of
 * creating another material.
 */
export async function publishMaterialImport(db, {
  ownerId,
  userAddress,
  importId,
  records,
  now = new Date(),
}) {
  if (!ownerId || !userAddress) throw new ImportValidationError("Import owner is required");
  importId = normalizeImportId(importId);
  await ensureMaterialImportIndexes(db);
  await ensureImportJob(db, { ownerId, importId, records, now });

  const rows = [];
  for (const record of records) {
    rows.push(await publishImportRow(db, { ownerId, userAddress, importId, record, now }));
  }

  const completed = rows.filter((row) => row.status === "complete").length;
  const imported = rows.filter((row) => row.status === "complete" && !row.reused).length;
  const reused = rows.filter((row) => row.status === "complete" && row.reused).length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const processing = rows.filter((row) => row.status === "processing").length;
  const complete = completed === records.length;
  const status = complete ? "complete" : failed > 0 ? "partial" : "processing";

  await db.collection(IMPORT_JOBS).updateOne(
    { ownerId, importId },
    {
      $set: {
        status,
        completed,
        failed,
        processing,
        updatedAt: now,
        ...(complete ? { completedAt: now } : {}),
      },
    },
  );

  return { importId, status, complete, total: records.length, completed, imported, reused, failed, processing, rows };
}
