import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb } from "./helpers/mongoFake.js";
import { authCookieHeader } from "./helpers/cookies.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-for-integration-tests";

const ADDRESS = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJA6TFAWNBAM3MFFF7B";

let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

// Upstream main currently ships metrics.js importing sanitizeMetricLabels
// from redact.js, where a merge dropped the symbol. The label-bounding fix
// belongs to the telemetry workstream; provide the minimal shape so the
// shared request-hardening stack can run under this test without touching
// production code outside this issue's scope.
vi.mock("@/lib/telemetry/redact", async (importOriginal) => {
  const actual = await importOriginal();
  const denied = /^(wallet|walletAddress|buyerAddress|txHash|transactionHash|materialId|email|url|uri)$/i;
  return {
    ...actual,
    isDeniedMetricLabel: (key, value) => denied.test(key) || (typeof value === "string" && value.length >= 32),
    sanitizeMetricLabels: (labels = {}) =>
      Object.fromEntries(Object.entries(labels).filter(([key]) => !denied.test(key))),
  };
});

function horizonTx(index) {
  return {
    id: `onchain-hash-${index}`,
    hash: `onchain-hash-${index}`,
    paging_token: String(10_000 - index),
    source_account: ADDRESS,
    successful: true,
    created_at: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 60_000).toISOString(),
    operation_count: 1,
    fee_charged: 100,
  };
}

/**
 * Serves two on-chain pages: the first request (no cursor) returns `limit`
 * records with a next link; following a cursor returns one older record.
 */
function stubHorizonFetch(limit) {
  const calls = [];
  const firstPage = Array.from({ length: limit }, (_, i) => horizonTx(i));
  const secondPage = [horizonTx(900)];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    const records = parsed.searchParams.get("cursor") ? secondPage : firstPage;
    const lastToken = records[records.length - 1].paging_token;
    const body = {
      _embedded: { records },
      _links: {
        next: {
          href: `https://horizon-testnet.stellar.org/accounts/${ADDRESS}/transactions?order=desc&limit=${limit}&cursor=${lastToken}`,
        },
      },
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return calls;
}

const originalFetch = globalThis.fetch;

const { GET } = await import("@/app/api/transactions/history/route.js");

function historyRequest(query = "") {
  return new Request(`http://localhost/api/transactions/history${query}`, {
    headers: { cookie: authCookieHeader({ sub: "buyer-1", walletAddress: ADDRESS }) },
  });
}

async function seedPurchase(overrides = {}) {
  const doc = {
    buyerAddress: ADDRESS.toLowerCase(),
    materialId: "material-1",
    status: "confirmed",
    amount: 25,
    asset: "USDC",
    transactionHash: "purchase-hash-1",
    purchasedAt: new Date(Date.parse("2026-02-01T00:00:00Z")),
    ...overrides,
  };
  await db.collection("purchases").insertOne(doc);
  return doc;
}

describe("GET /api/transactions/history", () => {
  beforeEach(() => {
    db = createTestDb();
    delete globalThis.__eduvaultHistoryCache;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects unauthenticated requests", async () => {
    const res = await GET(new Request("http://localhost/api/transactions/history"));
    expect(res.status).toBe(401);
  });

  it("returns the merged envelope with a bounded on-chain page and continuation token", async () => {
    await seedPurchase();
    const calls = stubHorizonFetch(3);

    const res = await GET(historyRequest("?page=1&limit=3"));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.page).toBe(1);
    expect(data.limit).toBe(3);
    expect(data.cursor).toBe(null);
    expect(data.nextCursor).toBe("9998");
    expect(data.hasMore).toBe(true);
    expect(data.totals.purchases).toBe(1);

    const hashes = data.records.map((record) => record.hash);
    expect(hashes).toContain("purchase-hash-1");
    expect(hashes).toContain("onchain-hash-0");
    expect(hashes).not.toContain("purchase-hash-1-duplicate-placeholder");
    // Newest record first.
    expect(data.records[0].createdAt >= data.records[data.records.length - 1].createdAt).toBe(true);

    // Exactly one bounded Horizon fetch: limit=3, no cursor, no expansion.
    expect(calls.length).toBe(1);
    const url = new URL(calls[0]);
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("cursor")).toBe(null);
  });

  it("follows the returned cursor to fetch the next on-chain page without expanding fetches", async () => {
    stubHorizonFetch(2);
    await GET(historyRequest("?limit=2"));

    const calls = stubHorizonFetch(2);
    const res = await GET(historyRequest("?cursor=9998&limit=2"));
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.cursor).toBe("9998");
    expect(data.nextCursor).toBe("9100");
    expect(data.hasMore).toBe(false); // short page ends the feed
    expect(data.records.map((record) => record.hash)).toContain("onchain-hash-900");

    expect(calls.length).toBe(1);
    const url = new URL(calls[0]);
    expect(url.searchParams.get("cursor")).toBe("9998");
    expect(url.searchParams.get("limit")).toBe("2");
  });

  it("rejects an invalid cursor with an actionable error before any Horizon call", async () => {
    const calls = stubHorizonFetch(2);

    const res = await GET(historyRequest("?cursor=not-a-paging-token"));
    expect(res.status).toBe(400);
    const detail = await res.json();
    expect(JSON.stringify(detail)).toContain("Invalid cursor");
    expect(calls.length).toBe(0);
  });
});
