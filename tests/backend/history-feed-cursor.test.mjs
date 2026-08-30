import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  fetchHorizonTransactions,
  isValidHorizonCursor,
} from "../../src/lib/transactions/historyFeed.js";

const ADDRESS = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJA6TFAWNBAM3MFFF7B";

function makeTx(index) {
  const token = String(10_000 - index);
  return {
    id: `hash-${index}`,
    hash: `hash-${index}`,
    paging_token: token,
    source_account: ADDRESS,
    ledger_attr: 5000 - index,
    successful: true,
    created_at: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 1000).toISOString(),
    operation_count: 1,
    fee_charged: 100,
    memo_type: "none",
  };
}

function horizonPage(records) {
  const lastToken = records.length ? records[records.length - 1].paging_token : "0";
  return {
    _embedded: { records },
    _links: {
      next: { href: `https://horizon-testnet.stellar.org/accounts/${ADDRESS}/transactions?order=desc&limit=20&cursor=${lastToken}` },
    },
  };
}

const originalFetch = globalThis.fetch;

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return calls;
}

describe("Horizon transaction feed cursor pagination", () => {
  beforeEach(() => {
    delete globalThis.__eduvaultHistoryCache;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("isValidHorizonCursor", () => {
    test("accepts decimal paging tokens", () => {
      assert.equal(isValidHorizonCursor("12884905984"), true);
      assert.equal(isValidHorizonCursor("0"), true);
    });

    test("rejects non-paging-token input before it reaches Horizon", () => {
      assert.equal(isValidHorizonCursor(""), false);
      assert.equal(isValidHorizonCursor("-1"), false);
      assert.equal(isValidHorizonCursor("abc"), false);
      assert.equal(isValidHorizonCursor("12;drop table"), false);
      assert.equal(isValidHorizonCursor(null), false);
      assert.equal(isValidHorizonCursor(undefined), false);
      assert.equal(isValidHorizonCursor(123), false);
      assert.equal(isValidHorizonCursor("1".repeat(33)), false);
    });
  });

  test("regression: each request fetches exactly one bounded page (no page*limit expansion)", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(horizonPage([])), { status: 200 }));

    // A deep page used to request page * limit records and slice locally.
    await fetchHorizonTransactions(ADDRESS, { limit: 20, cursor: "9990" });

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("cursor"), "9990");
    assert.equal(url.searchParams.get("order"), "desc");
  });

  test("first page omits the cursor parameter", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(horizonPage([])), { status: 200 }));

    await fetchHorizonTransactions(ADDRESS, { limit: 20 });

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get("cursor"), null);
    assert.equal(url.pathname, `/accounts/${encodeURIComponent(ADDRESS)}/transactions`);
  });

  test("returns normalized records with paging tokens, nextCursor and hasMore on a full page", async () => {
    const records = Array.from({ length: 3 }, (_, i) => makeTx(i));
    stubFetch(() => new Response(JSON.stringify(horizonPage(records)), { status: 200 }));

    const result = await fetchHorizonTransactions(ADDRESS, { limit: 3 });

    assert.equal(result.records.length, 3);
    assert.equal(result.records[0].hash, "hash-0");
    assert.equal(result.records[0].pagingToken, "10000");
    assert.equal(result.records[0].type, "onchain_transaction");
    assert.equal(result.nextCursor, "9998");
    assert.equal(result.hasMore, true);
  });

  test("short page ends the feed even when a next link exists", async () => {
    const records = Array.from({ length: 2 }, (_, i) => makeTx(i));
    stubFetch(() => new Response(JSON.stringify(horizonPage(records)), { status: 200 }));

    const result = await fetchHorizonTransactions(ADDRESS, { limit: 20 });

    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, "9999");
  });

  test("empty page for a stale cursor fails safe with no continuation", async () => {
    stubFetch(() => new Response(JSON.stringify(horizonPage([])), { status: 200 }));

    const result = await fetchHorizonTransactions(ADDRESS, { limit: 20, cursor: "1" });

    assert.deepEqual(result.records, []);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, null);
  });

  test("invalid cursor throws before any network call", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(horizonPage([])), { status: 200 }));

    await assert.rejects(
      () => fetchHorizonTransactions(ADDRESS, { limit: 20, cursor: "../etc/passwd" }),
      /Invalid Horizon paging token/
    );
    assert.equal(calls.length, 0);
  });

  test("Horizon failures surface an actionable error with the status code", async () => {
    stubFetch(() => new Response("unavailable", { status: 503 }));

    await assert.rejects(
      () => fetchHorizonTransactions(ADDRESS, { limit: 20 }),
      /Horizon request failed \(503\)/
    );
  });

  test("identical requests are served from cache without refetching; distinct cursors are not", async () => {
    const records = Array.from({ length: 2 }, (_, i) => makeTx(i));
    const calls = stubFetch(() => new Response(JSON.stringify(horizonPage(records)), { status: 200 }));

    const first = await fetchHorizonTransactions(ADDRESS, { limit: 2 });
    const second = await fetchHorizonTransactions(ADDRESS, { limit: 2 });
    await fetchHorizonTransactions(ADDRESS, { limit: 2, cursor: first.nextCursor });

    assert.equal(calls.length, 2);
    assert.deepEqual(second, first);
    const [firstUrl, secondUrl] = calls.map((value) => new URL(value));
    assert.equal(firstUrl.searchParams.get("cursor"), null);
    assert.equal(secondUrl.searchParams.get("cursor"), String(first.nextCursor));
  });

  test("limit is clamped to the Horizon maximum and invalid values fall back to the default", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify(horizonPage([])), { status: 200 }));

    await fetchHorizonTransactions(ADDRESS, { limit: 500 });
    await fetchHorizonTransactions(ADDRESS, { limit: Number.NaN });

    assert.equal(new URL(calls[0]).searchParams.get("limit"), "100");
    assert.equal(new URL(calls[1]).searchParams.get("limit"), "20");
  });
});
