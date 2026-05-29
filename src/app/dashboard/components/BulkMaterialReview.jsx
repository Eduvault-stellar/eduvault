"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FaCloudUploadAlt,
  FaExclamationTriangle,
  FaFileAlt,
  FaFileCode,
  FaFileCsv,
  FaInfoCircle,
  FaPaperPlane,
  FaSave,
  FaSyncAlt,
  FaCheckCircle,
} from "react-icons/fa";

function splitList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return String(value)
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value) {
  if (Array.isArray(value)) return value.join("\n");
  return value ? String(value) : "";
}

function parseCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return [];

  const rows = [];
  const headers = [];

  const parseLine = (line) => {
    const cells = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"' && inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (char === "," && !inQuotes) {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }

    cells.push(current.trim());
    return cells;
  };

  headers.push(...parseLine(lines[0]).map((header) => header.trim()));

  for (const line of lines.slice(1)) {
    const values = parseLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function normalizeRow(record, index) {
  return {
    id: `${Date.now()}-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    title: record.title || "",
    storageKey: record.storageKey || record.fileUrl || "",
    description: record.description || "",
    shortSummary: record.shortSummary || "",
    price: record.price === undefined || record.price === null ? "" : String(record.price),
    visibility: record.visibility || "private",
    category: record.category || "",
    subject: record.subject || "",
    level: record.level || "",
    usageRights: record.usageRights || "",
    coverImageUrl: record.coverImageUrl || "",
    thumbnailUrl: record.thumbnailUrl || "",
    learningOutcomesText: joinList(record.learningOutcomes),
    tableOfContentsText: joinList(record.tableOfContents),
    sampleNotesText: joinList(record.sampleNotes),
  };
}

function parseStructuredFile(text, fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseCsv(text);
  }

  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.records)) {
    return parsed.records;
  }

  if (Array.isArray(parsed.items)) {
    return parsed.items;
  }

  if (Array.isArray(parsed.materials)) {
    return parsed.materials;
  }

  throw new Error("JSON file must contain an array, records array, items array, or materials array.");
}

function toImportRecord(row) {
  return {
    title: row.title.trim(),
    storageKey: row.storageKey.trim(),
    description: row.description.trim(),
    shortSummary: row.shortSummary.trim(),
    price: row.price === "" ? 0 : Number(row.price),
    visibility: row.visibility.trim() || "private",
    category: row.category.trim() || undefined,
    subject: row.subject.trim() || undefined,
    level: row.level.trim() || undefined,
    usageRights: row.usageRights.trim() || undefined,
    coverImageUrl: row.coverImageUrl.trim() || undefined,
    thumbnailUrl: row.thumbnailUrl.trim() || undefined,
    learningOutcomes: splitList(row.learningOutcomesText),
    tableOfContents: splitList(row.tableOfContentsText),
    sampleNotes: splitList(row.sampleNotesText),
  };
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export default function BulkMaterialReview({ initialUser }) {
  const storageKey = useMemo(() => {
    const identifier = initialUser?.walletAddress || initialUser?.email || "creator";
    return `eduvault.bulk-import-draft:${identifier.toLowerCase()}`;
  }, [initialUser]);

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState([]);
  const [validation, setValidation] = useState(null);
  const [status, setStatus] = useState("empty");
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  useEffect(() => {
    const draft = typeof window === "undefined" ? null : safeJson(window.localStorage.getItem(storageKey));
    if (!draft || !Array.isArray(draft.rows) || draft.rows.length === 0) return;
    setFileName(draft.fileName || "Saved draft");
    setRows(draft.rows);
    setStatus("draft");
  }, [storageKey]);

  const invalidRowSet = useMemo(() => {
    const set = new Set();
    for (const entry of validation?.invalidRows || []) {
      set.add(entry.row);
    }
    return set;
  }, [validation]);

  const validRowCount = rows.length - invalidRowSet.size;
  const invalidRowCount = invalidRowSet.size;

  const updateRow = (id, field, value) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
    setStatus("dirty");
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setSuccess(null);
    setValidation(null);
    setStatus("loading");
    setFileName(file.name);

    try {
      const text = await file.text();
      const parsedRows = parseStructuredFile(text, file.name).map((record, index) => normalizeRow(record, index));
      setRows(parsedRows);
      setStatus("ready");
      await validateRows(parsedRows, { fileName: file.name });
    } catch (err) {
      setRows([]);
      setStatus("error");
      setError(err?.message || "Unable to read the file.");
    }
  };

  const validateRows = async (sourceRows = rows, options = {}) => {
    if (!sourceRows.length) {
      setValidation(null);
      return null;
    }

    setIsValidating(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/materials/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          format: "json",
          dryRun: true,
          records: sourceRows.map(toImportRecord),
        }),
      });

      const data = await response.json();
      setValidation(data);
      setStatus(response.ok ? "validated" : "needs-attention");
      if (!response.ok && data?.invalidRows?.length && !options.silent) {
        setError(
          `${data.invalidRows.length} row(s) need attention. Edit the highlighted records and validate again.`
        );
      } else if (response.ok && !options.silent) {
        setSuccess(
          options.fileName
            ? `${options.fileName} parsed successfully. ${data.valid} valid row(s) are ready for review.`
            : `${data.valid} row(s) are ready for review.`
        );
      }
      return data;
    } catch (err) {
      setStatus("error");
      if (!options.silent) {
        setError(err?.message || "Validation request failed.");
      }
      return null;
    } finally {
      setIsValidating(false);
    }
  };

  const saveDraft = () => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        fileName,
        rows,
        savedAt: new Date().toISOString(),
      })
    );
    setSuccess("Draft saved locally.");
    setStatus("draft");
  };

  const publishValidRows = async () => {
    const latestValidation = await validateRows(rows, { silent: true });
    const latestInvalidRows = new Set((latestValidation?.invalidRows || []).map((entry) => entry.row));
    const validRows = rows.filter((_, index) => !latestInvalidRows.has(index + 1));

    if (validRows.length === 0) {
      setError("There are no valid rows to publish.");
      return;
    }

    setIsPublishing(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch("/api/materials/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          format: "json",
          dryRun: false,
          records: validRows.map(toImportRecord),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || data?.message || "Publish failed.");
      }

      setSuccess(`${data.imported || validRows.length} row(s) published. ${latestInvalidRows.size} invalid row(s) were skipped.`);
      setStatus("published");
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(storageKey);
      }
    } catch (err) {
      setStatus("error");
      setError(err?.message || "Publish failed.");
    } finally {
      setIsPublishing(false);
    }
  };

  const emptyState = rows.length === 0;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white">
            <FaFileAlt />
            Bulk material review
          </div>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
            Review parsed rows before anything is published.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Upload a JSON or CSV file, inspect the parsed rows, fix invalid entries inline, save a local draft, then publish only the valid rows.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <div className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
            <FaExclamationTriangle className="text-amber-500" />
            No secrets required
          </div>
          <p>Only listing metadata is imported. Secret credentials are never requested.</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="space-y-6">
          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          {success ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {success}
            </div>
          ) : null}

          <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-900">Upload a structured file</div>
                <p className="mt-1 text-sm text-slate-600">
                  Supported inputs: JSON arrays, JSON records objects, and CSV with headers.
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">
                <FaCloudUploadAlt />
                <input
                  type="file"
                  accept=".json,.csv,application/json,text/csv"
                  onChange={handleFile}
                  className="hidden"
                />
                Choose file
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 font-medium text-slate-700">
                <FaFileCode />
                JSON
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 font-medium text-slate-700">
                <FaFileCsv />
                CSV
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 font-medium text-slate-700">
                <FaInfoCircle />
                Edit invalid rows inline
              </span>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-5 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  {fileName || "No file selected"}
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  {emptyState
                    ? "Drop in a structured file to begin review."
                    : `${rows.length} row(s) loaded. ${validRowCount} valid and ${invalidRowCount} needing attention.`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => validateRows()}
                  disabled={rows.length === 0 || isValidating}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FaSyncAlt className={isValidating ? "animate-spin" : ""} />
                  {isValidating ? "Validating..." : "Validate rows"}
                </button>
                <button
                  type="button"
                  onClick={saveDraft}
                  disabled={rows.length === 0}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FaSave />
                  Save draft
                </button>
                <button
                  type="button"
                  onClick={publishValidRows}
                  disabled={rows.length === 0 || validRowCount === 0 || isPublishing}
                  className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FaPaperPlane />
                  {isPublishing ? "Publishing..." : "Publish valid rows"}
                </button>
              </div>
            </div>

            {emptyState ? (
              <div className="grid place-items-center px-6 py-16 text-center">
                <div className="max-w-md">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
                    <FaFileAlt />
                  </div>
                  <h2 className="mt-4 text-lg font-semibold text-slate-900">No rows loaded yet</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Upload a CSV or JSON file to review parsed materials before publishing them to the catalog.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-4 p-5">
                {rows.map((row, index) => {
                  const rowNumber = index + 1;
                  const hasError = invalidRowSet.has(rowNumber);
                  const rowErrors = validation?.invalidRows?.find((entry) => entry.row === rowNumber)?.errors || [];

                  return (
                    <article
                      key={row.id}
                      className={`rounded-3xl border p-5 transition ${
                        hasError ? "border-red-200 bg-red-50/60" : "border-slate-200 bg-slate-50/50"
                      }`}
                    >
                      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                            Row {rowNumber}
                          </div>
                          <div className="mt-1 text-sm font-semibold text-slate-900">
                            {row.title || "Untitled material"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {hasError ? (
                            <span className="inline-flex items-center gap-2 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700">
                              <FaExclamationTriangle />
                              Needs attention
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                              <FaCheckCircle />
                              Valid
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Title
                          </span>
                          <input
                            type="text"
                            value={row.title}
                            onChange={(event) => updateRow(row.id, "title", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Storage key
                          </span>
                          <input
                            type="text"
                            value={row.storageKey}
                            onChange={(event) => updateRow(row.id, "storageKey", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Price
                          </span>
                          <input
                            type="number"
                            step="0.01"
                            value={row.price}
                            onChange={(event) => updateRow(row.id, "price", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Visibility
                          </span>
                          <select
                            value={row.visibility}
                            onChange={(event) => updateRow(row.id, "visibility", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          >
                            <option value="private">Private</option>
                            <option value="public">Public</option>
                            <option value="unlisted">Unlisted</option>
                          </select>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Category
                          </span>
                          <input
                            type="text"
                            value={row.category}
                            onChange={(event) => updateRow(row.id, "category", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Subject
                          </span>
                          <input
                            type="text"
                            value={row.subject}
                            onChange={(event) => updateRow(row.id, "subject", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Level
                          </span>
                          <input
                            type="text"
                            value={row.level}
                            onChange={(event) => updateRow(row.id, "level", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block md:col-span-2 xl:col-span-3">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Description
                          </span>
                          <textarea
                            rows={3}
                            value={row.description}
                            onChange={(event) => updateRow(row.id, "description", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block md:col-span-2 xl:col-span-3">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Short summary
                          </span>
                          <textarea
                            rows={2}
                            value={row.shortSummary}
                            onChange={(event) => updateRow(row.id, "shortSummary", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block md:col-span-2 xl:col-span-3">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Usage rights
                          </span>
                          <textarea
                            rows={2}
                            value={row.usageRights}
                            onChange={(event) => updateRow(row.id, "usageRights", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Cover image URL
                          </span>
                          <input
                            type="url"
                            value={row.coverImageUrl}
                            onChange={(event) => updateRow(row.id, "coverImageUrl", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Thumbnail URL
                          </span>
                          <input
                            type="url"
                            value={row.thumbnailUrl}
                            onChange={(event) => updateRow(row.id, "thumbnailUrl", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block md:col-span-2 xl:col-span-3">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Learning outcomes
                          </span>
                          <textarea
                            rows={2}
                            value={row.learningOutcomesText}
                            onChange={(event) => updateRow(row.id, "learningOutcomesText", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block md:col-span-2 xl:col-span-3">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Table of contents
                          </span>
                          <textarea
                            rows={2}
                            value={row.tableOfContentsText}
                            onChange={(event) => updateRow(row.id, "tableOfContentsText", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                        <label className="block md:col-span-2 xl:col-span-3">
                          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Sample notes
                          </span>
                          <textarea
                            rows={2}
                            value={row.sampleNotesText}
                            onChange={(event) => updateRow(row.id, "sampleNotesText", event.target.value)}
                            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </label>
                      </div>

                      {rowErrors.length > 0 ? (
                        <div className="mt-4 rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm text-red-800">
                          <div className="font-semibold">Validation issues</div>
                          <ul className="mt-2 space-y-1">
                            {rowErrors.map((item, errorIndex) => (
                              <li key={`${row.id}-error-${errorIndex}`}>• {item.field}: {item.message}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-slate-950 p-6 text-white">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
              Review summary
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Rows</div>
                <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Valid</div>
                <div className="mt-1 text-2xl font-semibold">{validRowCount}</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Needs fix</div>
                <div className="mt-1 text-2xl font-semibold">{invalidRowCount}</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">State</div>
                <div className="mt-1 text-sm font-semibold capitalize">{status}</div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <FaInfoCircle className="text-slate-500" />
              Workflow
            </div>
            <ol className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
              <li>1. Upload JSON or CSV with material metadata.</li>
              <li>2. Review the parsed rows and fix invalid entries inline.</li>
              <li>3. Save a local draft or publish only the valid rows.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
