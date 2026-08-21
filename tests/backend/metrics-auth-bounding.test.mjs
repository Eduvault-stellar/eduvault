import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import {
  incrementCounter,
  setGauge,
  recordHistogram,
  getMetricsSnapshot,
  resetMetrics,
  toPrometheusFormat,
} from "../../src/lib/telemetry/metrics.js";

import {
  isDeniedMetricLabel,
  sanitizeMetricLabels,
} from "../../src/lib/telemetry/redact.js";

import { GET } from "../../src/app/api/metrics/route.js";

beforeEach(() => {
  resetMetrics();
});

describe("Metric Label Bounding & Redaction", () => {
  test("identifies denied metric label keys (wallets, txs, materials, emails, URLs)", () => {
    // Keys
    assert.equal(isDeniedMetricLabel("wallet"), true);
    assert.equal(isDeniedMetricLabel("buyerAddress"), true);
    assert.equal(isDeniedMetricLabel("txHash"), true);
    assert.equal(isDeniedMetricLabel("transactionId"), true);
    assert.equal(isDeniedMetricLabel("materialId"), true);
    assert.equal(isDeniedMetricLabel("email"), true);
    assert.equal(isDeniedMetricLabel("url"), true);
    assert.equal(isDeniedMetricLabel("uri"), true);

    // Allowed keys
    assert.equal(isDeniedMetricLabel("route"), false);
    assert.equal(isDeniedMetricLabel("method"), false);
    assert.equal(isDeniedMetricLabel("outcome"), false);
    assert.equal(isDeniedMetricLabel("source"), false);
  });

  test("identifies denied metric label values matching wallets, txs, materials, emails, URLs", () => {
    // Value detection
    assert.equal(isDeniedMetricLabel("custom_id", "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJA6TFAWNBAM3MFFF7B"), true); // Stellar pubkey
    assert.equal(isDeniedMetricLabel("custom_id", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"), true); // EVM address
    assert.equal(isDeniedMetricLabel("custom_id", "user@example.com"), true); // Email
    assert.equal(isDeniedMetricLabel("custom_id", "https://example.com/api/test"), true); // URL
    assert.equal(isDeniedMetricLabel("custom_id", "mat-12345678"), true); // Material ID
    assert.equal(isDeniedMetricLabel("custom_id", "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"), true); // Tx hash
  });

  test("sanitizeMetricLabels strips forbidden labels while retaining valid labels", () => {
    const raw = {
      route: "checkout",
      method: "POST",
      wallet: "GABC123",
      buyerAddress: "0x123",
      txHash: "0xdeadbeef",
      materialId: "m1",
      email: "test@example.com",
      url: "https://eduvault.io/checkout",
      outcome: "success",
    };

    const sanitized = sanitizeMetricLabels(raw);

    assert.deepEqual(sanitized, {
      route: "checkout",
      method: "POST",
      outcome: "success",
    });
  });

  test("incrementCounter, setGauge, recordHistogram enforce label sanitization", () => {
    incrementCounter("http_requests_total", {
      route: "checkout",
      wallet: "GABC123",
      email: "leaked@example.com",
    });

    setGauge("indexer_lag", {
      source: "stellar",
      txHash: "0x12345",
    }, 10);

    recordHistogram("request_duration", {
      route: "upload",
      url: "https://eduvault.io/upload",
    }, 120);

    const text = toPrometheusFormat();

    // Verify bounded labels remain
    assert.match(text, /route="checkout"/);
    assert.match(text, /source="stellar"/);
    assert.match(text, /route="upload"/);

    // Verify sensitive labels are omitted
    assert.doesNotMatch(text, /wallet/);
    assert.doesNotMatch(text, /email/);
    assert.doesNotMatch(text, /leaked/);
    assert.doesNotMatch(text, /txHash/);
    assert.doesNotMatch(text, /url=/);
  });
});

describe("Metrics Endpoint Collector Authorization", () => {
  const ORIGINAL_ENV = process.env.METRICS_COLLECTOR_SECRET;

  beforeEach(() => {
    delete process.env.METRICS_COLLECTOR_SECRET;
    delete process.env.METRICS_SECRET;
  });

  test("returns 200 OK when no collector secret is set in dev/test", async () => {
    const req = new Request("http://localhost:3000/api/metrics");
    const res = await GET(req);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; version=0.0.4");
  });

  test("returns 401 Unauthorized when secret is set and request has no auth header", async () => {
    process.env.METRICS_COLLECTOR_SECRET = "super-secret-collector-token";
    const req = new Request("http://localhost:3000/api/metrics");
    const res = await GET(req);
    assert.equal(res.status, 401);
  });

  test("returns 401 Unauthorized when secret is set and token is wrong", async () => {
    process.env.METRICS_COLLECTOR_SECRET = "super-secret-collector-token";
    const req = new Request("http://localhost:3000/api/metrics", {
      headers: { authorization: "Bearer invalid-token" },
    });
    const res = await GET(req);
    assert.equal(res.status, 401);
  });

  test("returns 200 OK when secret is set and valid Bearer token is provided", async () => {
    process.env.METRICS_COLLECTOR_SECRET = "super-secret-collector-token";
    const req = new Request("http://localhost:3000/api/metrics", {
      headers: { authorization: "Bearer super-secret-collector-token" },
    });
    const res = await GET(req);
    assert.equal(res.status, 200);
  });

  test("returns 200 OK when secret is set and valid x-metrics-secret header is provided", async () => {
    process.env.METRICS_SECRET = "another-secret-token";
    const req = new Request("http://localhost:3000/api/metrics", {
      headers: { "x-metrics-secret": "another-secret-token" },
    });
    const res = await GET(req);
    assert.equal(res.status, 200);
  });
});
