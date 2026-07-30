import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  computeRelevanceScore,
  encodeCursor,
  decodeCursor,
  validateSortField,
  clampResultWindow,
  MAX_SEARCH_LENGTH,
  MAX_CLAUSES,
  MAX_RESULT_WINDOW,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_REGEX_LENGTH,
  VALID_SORT_FIELDS,
  CURSOR_VERSION,
} from "../../src/lib/backend/marketplaceDiscovery.js";

function params(input) {
  return new URLSearchParams(input);
}

describe("buildMarketplaceDiscoveryQuery", () => {
  test("combines all discovery filters", () => {
    const query = buildMarketplaceDiscoveryQuery(
      params({
        search: "cell biology",
        subject: "biology",
        level: "advanced",
        contentType: "pdf",
        minPrice: "2",
        maxPrice: "10",
        licenseType: "creative-commons",
        minRating: "4",
        newest: "30d",
      }),
      { now: new Date("2026-06-25T00:00:00.000Z") }
    );

    assert.equal(query.visibility, "public");
    assert.equal(query.status, "published");
    assert.equal(query.subject, "biology");
    assert.equal(query.level, "advanced");
    assert.deepEqual(query.price, { $gte: 2, $lte: 10 });
    assert.equal(query.usageRights, "Creative Commons");
    assert.deepEqual(query.rating, { $gte: 4 });
    assert.deepEqual(query.createdAt, { $gte: new Date("2026-05-26T00:00:00.000Z") });
    assert.ok(query.$and.length >= 2);
  });

  test("ignores invalid numeric filters", () => {
    const query = buildMarketplaceDiscoveryQuery(
      params({
        minPrice: "free",
        maxPrice: "",
        minRating: "stars",
      })
    );

    assert.equal(query.price, undefined);
    assert.equal(query.rating, undefined);
  });

  test("excludes non-published materials from public results", () => {
    const query = buildMarketplaceDiscoveryQuery(params({}));
    assert.equal(query.status, "published");
  });

  test("maxClauses parameter is respected", () => {
    const query = buildMarketplaceDiscoveryQuery(
      params({ search: "biology" }),
      { maxClauses: 1 }
    );
    assert.ok(query.$and && query.$and.length <= 1);
  });

  test("throws on search term exceeding regex length limit", () => {
    const longSearch = "a".repeat(MAX_REGEX_LENGTH + 1);
    assert.throws(
      () => buildMarketplaceDiscoveryQuery(params({ search: longSearch })),
      /Search term too long/
    );
  });

  test("sanitizes regex special characters in search", () => {
    const query = buildMarketplaceDiscoveryQuery(params({ search: "test.*file" }));
    const andClause = query.$and[0];
    const titleRegex = andClause.$or.find((c) => c.title);
    assert.ok(titleRegex.title instanceof RegExp);
    assert.ok(!titleRegex.title.source.includes(".*"));
  });

  test("strips control characters from search input", () => {
    const query = buildMarketplaceDiscoveryQuery(
      params({ search: "hello\u0000world" })
    );
    const andClause = query.$and[0];
    const titleRegex = andClause.$or.find((c) => c.title);
    assert.ok(!titleRegex.title.source.includes("\u0000"));
  });
});

describe("buildMarketplaceSort", () => {
  test("supports newest, rating, popular, and price order", () => {
    assert.deepEqual(buildMarketplaceSort("newest"), { createdAt: -1, _id: 1 });
    assert.deepEqual(buildMarketplaceSort("rating_desc"), { rating: -1, createdAt: -1, _id: 1 });
    assert.deepEqual(buildMarketplaceSort("popular"), { likes: -1, rating: -1, createdAt: -1, _id: 1 });
    assert.deepEqual(buildMarketplaceSort("price_asc"), { price: 1, createdAt: -1, _id: 1 });
    assert.deepEqual(buildMarketplaceSort("price_desc"), { price: -1, createdAt: -1, _id: 1 });
  });

  test("includes _id tie-breaker for deterministic ordering", () => {
    const sort = buildMarketplaceSort("newest");
    assert.ok(sort._id === 1, "Sort must include _id tie-breaker");
  });

  test("defaults to newest sort", () => {
    assert.deepEqual(buildMarketplaceSort("unknown"), { createdAt: -1, _id: 1 });
    assert.deepEqual(buildMarketplaceSort(undefined), { createdAt: -1, _id: 1 });
  });

  test("supports relevance_desc sort", () => {
    assert.deepEqual(buildMarketplaceSort("relevance_desc"), { relevanceScore: -1, createdAt: -1, _id: 1 });
  });
});

describe("encodeCursor / decodeCursor", () => {
  test("encodes and decodes a cursor deterministically", () => {
    const createdAt = new Date("2026-06-25T12:00:00.000Z");
    const id = "abc123";
    const cursor = encodeCursor(createdAt, id);
    const decoded = decodeCursor(cursor);
    assert.equal(decoded.id, id);
    assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  });

  test("cursor is opaque (not human-readable)", () => {
    const cursor = encodeCursor(new Date("2026-06-25T12:00:00.000Z"), "abc123");
    assert.ok(!cursor.includes("2026"));
    assert.ok(!cursor.includes("abc123"));
  });

  test("rejects cursor with incompatible version", () => {
    const badCursor = Buffer.from("99|2026-06-25T12:00:00.000Z|abc123").toString("base64");
    assert.throws(() => decodeCursor(badCursor), /Incompatible cursor version/);
  });

  test("rejects malformed cursor", () => {
    assert.throws(() => decodeCursor("not-valid-base64!!!"), /Invalid cursor/);
  });

  test("rejects cursor with invalid date", () => {
    const badCursor = Buffer.from("1|not-a-date|abc123").toString("base64");
    assert.throws(() => decodeCursor(badCursor), /Invalid cursor date/);
  });

  test("cursors with same createdAt but different _id are distinct", () => {
    const createdAt = new Date("2026-06-25T12:00:00.000Z");
    const cursor1 = encodeCursor(createdAt, "abc");
    const cursor2 = encodeCursor(createdAt, "def");
    assert.notEqual(cursor1, cursor2);
    assert.equal(decodeCursor(cursor1).id, "abc");
    assert.equal(decodeCursor(cursor2).id, "def");
  });
});

describe("validateSortField", () => {
  test("accepts valid sort fields", () => {
    for (const field of VALID_SORT_FIELDS) {
      assert.equal(validateSortField(field), field);
    }
  });

  test("defaults to newest for empty or invalid input", () => {
    assert.equal(validateSortField(""), "newest");
    assert.equal(validateSortField(null), "newest");
    assert.equal(validateSortField(undefined), "newest");
  });

  test("throws on invalid sort field", () => {
    assert.throws(
      () => validateSortField("invalid_sort"),
      /Invalid sort field/
    );
  });
});

describe("clampResultWindow", () => {
  test("clamps page size to bounds", () => {
    assert.deepEqual(clampResultWindow(1, 100), { page: 1, pageSize: MAX_PAGE_SIZE });
    assert.deepEqual(clampResultWindow(1, 0), { page: 1, pageSize: MIN_PAGE_SIZE });
  });

  test("throws when result window exceeds maximum", () => {
    assert.throws(
      () => clampResultWindow(100, MAX_PAGE_SIZE),
      /Result window exceeds maximum/
    );
  });

  test("accepts valid page and page size", () => {
    assert.deepEqual(clampResultWindow(1, 12), { page: 1, pageSize: 12 });
    assert.deepEqual(clampResultWindow(5, 25), { page: 5, pageSize: 25 });
  });
});

describe("computeRelevanceScore", () => {
  test("returns higher score for title matches", () => {
    const material = { title: "Cell Biology Guide", description: "A guide", tags: [] };
    const score = computeRelevanceScore(material, "Cell Biology");
    assert.ok(score > 0);
  });

  test("returns zero score when no search term", () => {
    const material = { title: "Guide", description: "A guide", tags: [] };
    assert.equal(computeRelevanceScore(material, ""), 0);
    assert.equal(computeRelevanceScore(material, null), 0);
  });

  test("awards bonus for tag matches", () => {
    const material = {
      title: "Guide",
      description: "A guide",
      tags: ["biology", "cell"],
    };
    const score = computeRelevanceScore(material, "biology");
    assert.ok(score > 0);
  });

  test("is resistant to trivial manipulation via tag stuffing", () => {
    const material = {
      title: "Guide",
      description: "A guide",
      tags: ["biology", "biology", "biology", "biology", "biology"],
    };
    const score = computeRelevanceScore(material, "biology");
    assert.ok(score < 100, "Score should be bounded even with repeated tags");
  });

  test("incorporates rating and likes as soft signals", () => {
    const highRated = { title: "Guide", rating: 5, likes: 100, tags: [] };
    const lowRated = { title: "Guide", rating: 1, likes: 0, tags: [] };
    assert.ok(computeRelevanceScore(highRated, "guide") > computeRelevanceScore(lowRated, "guide"));
  });
});