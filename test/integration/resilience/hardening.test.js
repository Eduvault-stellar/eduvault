import { describe, it, expect, vi, beforeEach } from "vitest";
import { DependencyError } from "@/lib/resilience/index";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ body, status: init?.status || 200, headers: new Map(), headersSet: {} })),
  },
}));

vi.mock("@/lib/api/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/api/rateLimit", () => ({ checkRateLimit: vi.fn(() => ({ allowed: true, limit: 100, remaining: 99, retryAfter: 0 })) }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/telemetry/context", () => ({ runWithContext: vi.fn((ctx, fn) => fn()), currentTraceparent: vi.fn(), currentCorrelationId: vi.fn(() => "test-cid") }));
vi.mock("@/lib/telemetry/tracing", () => ({ withSpan: vi.fn((n, o, fn) => fn({ setAttribute: vi.fn() })) }));
vi.mock("@/lib/telemetry/metrics", () => ({ incrementCounter: vi.fn(), recordHistogram: vi.fn() }));
vi.mock("@/lib/capacity/concurrency", () => ({ acquireSlot: vi.fn(() => ({ acquired: true, release: vi.fn(), overload: false })) }));
vi.mock("@/lib/capacity/shed", () => ({ preRequestShed: vi.fn(() => ({ shed: false })) }));
vi.mock("@/lib/capacity/budgets", () => ({ resolveRouteBudget: vi.fn(() => ({ maxPayloadBytes: 0 })) }));
vi.mock("@/lib/capacity/backpressure", () => ({ createDisconnectSignal: vi.fn(() => ({ signal: null, cleanup: vi.fn() })) }));
vi.mock("@/lib/api/contract", () => ({ enforceApiResponse: vi.fn((r) => r), negotiateApiVersion: vi.fn() }));
vi.mock("@/lib/security/clientAddress", () => ({ resolveTrustedClientIp: vi.fn(() => "127.0.0.1") }));

function makeRequest() {
  const store = {};
  const h = {
    get: (k) => store[k] || null,
    set: (k, v) => { store[k] = v; },
  };
  return { method: "GET", headers: h, nextUrl: { pathname: "/api/test" }, url: "http://localhost/api/test" };
}

describe("Hardening layer DependencyError handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps DependencyError to 503 with userMessage", async () => {
    const { withApiHardening } = await import("@/lib/api/hardening");
    const { NextResponse } = await import("next/server");
    const handler = vi.fn().mockRejectedValue(
      new DependencyError({ dependency: "test-dep", action: "test-action", userMessage: "Test is down" })
    );

    await withApiHardening(makeRequest(), { route: "test-route" }, handler);
    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Test is down", dependency: "test-dep" }),
      expect.objectContaining({ status: 503 })
    );
  });

  it("generic error maps to 500", async () => {
    const { withApiHardening } = await import("@/lib/api/hardening");
    const { NextResponse } = await import("next/server");
    const handler = vi.fn().mockRejectedValue(new Error("something broke"));

    await withApiHardening(makeRequest(), { route: "test-route" }, handler);
    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Internal Server Error" }),
      expect.objectContaining({ status: 500 })
    );
  });
});
