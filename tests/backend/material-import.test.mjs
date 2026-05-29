import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  validateImportPayload,
  validateImportRow,
  validateImportSchema,
  ImportValidationError,
} from "../../src/lib/backend/materialImport.js";

describe("validateImportSchema", () => {
  test("accepts valid payload with records", () => {
    const result = validateImportSchema({
      records: [{ title: "Test", storageKey: "ipfs://file" }],
    });
    assert.equal(result.format, "json");
    assert.equal(result.dryRun, true);
    assert.equal(result.records.length, 1);
  });

  test("accepts items array", () => {
    const result = validateImportSchema({
      items: [{ title: "Test", storageKey: "ipfs://file" }],
    });
    assert.equal(result.records.length, 1);
  });

  test("rejects empty records", () => {
    assert.throws(
      () => validateImportSchema({ records: [] }),
      /contains no records/
    );
  });

  test("rejects missing records", () => {
    assert.throws(
      () => validateImportSchema({}),
      /must contain a 'records'/
    );
  });

  test("rejects too many records", () => {
    const records = Array.from({ length: 501 }, (_, i) => ({
      title: `Test ${i}`,
      storageKey: `ipfs://file-${i}`,
    }));
    assert.throws(
      () => validateImportSchema({ records }),
      /Maximum 500 records/
    );
  });

  test("rejects unsupported format", () => {
    assert.throws(
      () => validateImportSchema({ format: "xml", records: [{ title: "T", storageKey: "ipfs://f" }] }),
      /Unsupported import format/
    );
  });

  test("dryRun defaults to true", () => {
    const result = validateImportSchema({
      records: [{ title: "Test", storageKey: "ipfs://file" }],
    });
    assert.equal(result.dryRun, true);
  });

  test("dryRun can be set to false", () => {
    const result = validateImportSchema({
      records: [{ title: "Test", storageKey: "ipfs://file" }],
      dryRun: false,
    });
    assert.equal(result.dryRun, false);
  });
});

describe("validateImportRow", () => {
  test("validates a complete valid row", () => {
    const result = validateImportRow({
      title: "  Calculus Notes  ",
      storageKey: "ipfs://QmFile",
      price: "10",
      subject: "Math",
      level: "advanced",
    }, 0);

    assert.equal(result.valid, true);
    assert.equal(result.data.title, "Calculus Notes");
    assert.equal(result.data.price, 10);
    assert.equal(result.data.subject, "mathematics");
    assert.equal(result.data.level, "advanced");
  });

  test("rejects row without title", () => {
    const result = validateImportRow({ storageKey: "ipfs://file" }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "title"));
  });

  test("rejects row without storageKey", () => {
    const result = validateImportRow({ title: "Test" }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "storageKey"));
  });

  test("rejects invalid price", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      price: "not-a-number",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "price"));
  });

  test("rejects invalid visibility", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      visibility: "secret",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "visibility"));
  });

  test("rejects unknown subject", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      subject: "astrology",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "subject"));
  });

  test("rejects unknown category", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      category: "unknown-cat",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "category"));
  });

  test("rejects unknown level", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      level: "expert",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "level"));
  });

  test("accepts row with only required fields", () => {
    const result = validateImportRow({
      title: "Minimal",
      storageKey: "ipfs://file",
    }, 0);
    assert.equal(result.valid, true);
    assert.equal(result.data.title, "Minimal");
    assert.equal(result.data.visibility, "private");
  });

  test("accepts fileUrl as alternative to storageKey", () => {
    const result = validateImportRow({
      title: "Test",
      fileUrl: "ipfs://file-url",
    }, 0);
    assert.equal(result.valid, true);
    assert.equal(result.data.storageKey, "ipfs://file-url");
  });
});

describe("validateImportPayload", () => {
  test("validates multiple records", () => {
    const result = validateImportPayload({
      records: [
        { title: "Valid", storageKey: "ipfs://a" },
        { title: "", storageKey: "ipfs://b" },
        { title: "Also Valid", storageKey: "ipfs://c" },
      ],
    });

    assert.equal(result.total, 3);
    assert.equal(result.valid, 2);
    assert.equal(result.invalid, 1);
    assert.equal(result.invalidRows.length, 1);
    assert.equal(result.invalidRows[0].row, 2);
  });

  test("returns row-level errors with details", () => {
    const result = validateImportPayload({
      records: [
        { title: "Good", storageKey: "ipfs://a" },
        { title: "Bad", storageKey: "ipfs://b", price: "free", subject: "unknown" },
      ],
    });

    assert.equal(result.invalid, 1);
    assert.equal(result.invalidRows[0].row, 2);
    assert.ok(result.invalidRows[0].errors.some((e) => e.field === "price"));
    assert.ok(result.invalidRows[0].errors.some((e) => e.field === "subject"));
  });

  test("dry-run mode does not include saved records", () => {
    const result = validateImportPayload({
      records: [
        { title: "Test", storageKey: "ipfs://a" },
      ],
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.valid, 1);
    assert.equal(result.validRecords.length, 1);
  });
});
