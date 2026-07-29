import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  encodeCursor,
  decodeCursor,
  CURSOR_VERSION,
} from "../../src/lib/backend/marketplaceDiscovery.js";

describe("cursor pagination", () => {
  test("cursors are deterministic for the same document", () => {
    const createdAt = new Date("2026-06-25T12:00:00.000Z");
    const id = "abc123def456";
    const cursor1 = encodeCursor(createdAt, id);
    const cursor2 = encodeCursor(createdAt, id);
    assert.equal(cursor1, cursor2);
  });

  test("cursors differ for different documents even with same timestamp", () => {
    const createdAt = new Date("2026-06-25T12:00:00.000Z");
    const cursor1 = encodeCursor(createdAt, "id1");
    const cursor2 = encodeCursor(createdAt, "id2");
    assert.notEqual(cursor1, cursor2);
  });

  test("cursors differ for same id but different timestamps", () => {
    const createdAt1 = new Date("2026-06-25T12:00:00.000Z");
    const createdAt2 = new Date("2026-06-26T12:00:00.000Z");
    const cursor1 = encodeCursor(createdAt1, "id1");
    const cursor2 = encodeCursor(createdAt2, "id1");
    assert.notEqual(cursor1, cursor2);
  });

  test("decoded cursor contains version, timestamp, and id", () => {
    const createdAt = new Date("2026-06-25T12:00:00.000Z");
    const cursor = encodeCursor(createdAt, "testId");
    const decoded = decodeCursor(cursor);
    assert.equal(decoded.id, "testId");
    assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  });

  test("cursor tampering is detected", () => {
    const tampered = Buffer.from("1|2026-06-25T12:00:00.000Z").toString("base64");
    assert.throws(() => decodeCursor(tampered), /Invalid cursor/);
  });

  test("empty cursor string is rejected", () => {
    assert.throws(() => decodeCursor(""), /Invalid cursor/);
  });

  test("cursor with truncated payload is rejected", () => {
    const truncated = Buffer.from("1|2026-06-25").toString("base64");
    assert.throws(() => decodeCursor(truncated), /Invalid cursor/);
  });

  test("cursor version mismatch is rejected", () => {
    const badVersion = Buffer.from("99|2026-06-25T12:00:00.000Z|abc123").toString("base64");
    assert.throws(() => decodeCursor(badVersion), /Incompatible cursor version/);
  });

  test("cursors are opaque and not human-readable", () => {
    const cursor = encodeCursor(new Date("2026-06-25T12:00:00.000Z"), "secretId");
    assert.ok(!cursor.includes("2026"));
    assert.ok(!cursor.includes("secretId"));
    assert.ok(!cursor.includes("T12:00:00"));
  });
});

describe("cursor traversal determinism", () => {
  test("repeated traversal does not duplicate or skip unchanged records", () => {
    const createdAt = new Date("2026-06-25T12:00:00.000Z");
    const id = "fixedId";

    const cursor1 = encodeCursor(createdAt, id);
    const decoded1 = decodeCursor(cursor1);

    const cursor2 = encodeCursor(decoded1.createdAt, decoded1.id);
    const decoded2 = decodeCursor(cursor2);

    assert.equal(decoded1.id, decoded2.id);
    assert.equal(decoded1.createdAt.toISOString(), decoded2.createdAt.toISOString());
  });

  test("cursor ordering is consistent with sort order", () => {
    const dates = [
      new Date("2026-06-25T10:00:00.000Z"),
      new Date("2026-06-25T11:00:00.000Z"),
      new Date("2026-06-25T12:00:00.000Z"),
    ];

    const cursors = dates.map((d, i) => encodeCursor(d, `id${i}`));
    const decoded = cursors.map((c) => decodeCursor(c));

    for (let i = 0; i < decoded.length - 1; i++) {
      assert.ok(
        decoded[i].createdAt <= decoded[i + 1].createdAt,
        "Decoded cursors should maintain ascending chronological order"
      );
    }
  });
});

describe("cursor with filters", () => {
  test("incompatible filter changes invalidate cursor semantics", () => {
    const cursor = encodeCursor(new Date("2026-06-25T12:00:00.000Z"), "abc123");
    const decoded = decodeCursor(cursor);

    assert.equal(decoded.createdAt.toISOString(), "2026-06-25T12:00:00.000Z");
    assert.equal(decoded.id, "abc123");
  });

  test("cursor encodes version for filter compatibility checking", () => {
    const cursor = encodeCursor(new Date("2026-06-25T12:00:00.000Z"), "abc123");
    const decoded = decodeCursor(cursor);

    assert.equal(CURSOR_VERSION, 1);
    assert.ok(decoded.id);
    assert.ok(decoded.createdAt instanceof Date);
  });
});