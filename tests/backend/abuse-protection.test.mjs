/**
 * Tests for layered abuse protection (Issue #100):
 *  1. Proxy/header trust — X-Forwarded-For / X-Real-IP are only trusted
 *     when TRUST_PROXY=true, preventing trivial client spoofing.
 *  2. Route budget resolution — withApiHardening's capacity budgets are
 *     looked up by request pathname first, then by label, so previously
 *     orphaned ROUTE_BUDGETS entries (keyed like "/api/purchase") actually
 *     apply to the routes they were written for.
 *  3. Newly protected route classes (state transitions, admin, application
 *     creation, payment flows) have sane critical/high-priority budgets.
 *
 * Run with: npm run test:backend
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

// proxy.js and lib/api/hardening.js both import "next/server", which only
// resolves inside Next's bundler — not under plain `node --test`. Both
// delegate their trust-gating to this dependency-free helper, so we test
// the shared logic directly (see docs on resolveTrustedClientIp).
import { resolveTrustedClientIp } from "../../src/lib/security/clientAddress.js";
import { resolveRouteBudget, getRouteBudget, ROUTE_BUDGETS } from "../../src/lib/capacity/budgets.js";

function clientIp(request) {
  return resolveTrustedClientIp(request, { fallback: "anonymous" });
}

function clientKey(request) {
  return resolveTrustedClientIp(request, { fallback: "local" });
}

function createMockRequest({ headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
    },
  };
}

function withTrustProxy(value, fn) {
  const previous = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
}

describe("Abuse protection (#100) — proxy header trust", () => {
  test("clientIp ignores X-Forwarded-For/X-Real-IP when TRUST_PROXY is unset", () => {
    withTrustProxy(undefined, () => {
      const req = createMockRequest({
        headers: { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.1" },
      });
      assert.equal(clientIp(req), "anonymous");
    });
  });

  test("clientIp ignores forwarded headers when TRUST_PROXY is not exactly 'true'", () => {
    withTrustProxy("1", () => {
      const req = createMockRequest({ headers: { "x-forwarded-for": "203.0.113.1" } });
      assert.equal(clientIp(req), "anonymous");
    });
  });

  test("clientIp trusts X-Forwarded-For only when TRUST_PROXY=true", () => {
    withTrustProxy("true", () => {
      const req = createMockRequest({ headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" } });
      assert.equal(clientIp(req), "203.0.113.1");
    });
  });

  test("clientIp falls back to X-Real-IP when trusted and X-Forwarded-For absent", () => {
    withTrustProxy("true", () => {
      const req = createMockRequest({ headers: { "x-real-ip": "203.0.113.9" } });
      assert.equal(clientIp(req), "203.0.113.9");
    });
  });

  test("clientKey (API hardening) ignores X-Real-IP when TRUST_PROXY is unset — a direct client cannot spoof it", () => {
    withTrustProxy(undefined, () => {
      const req = createMockRequest({ headers: { "x-real-ip": "203.0.113.1" } });
      assert.equal(clientKey(req), "local");
    });
  });

  test("clientKey trusts forwarded headers only when TRUST_PROXY=true", () => {
    withTrustProxy("true", () => {
      const req = createMockRequest({ headers: { "x-forwarded-for": "198.51.100.5" } });
      assert.equal(clientKey(req), "198.51.100.5");
    });
  });
});

describe("Abuse protection (#100) — route budget resolution", () => {
  test("resolveRouteBudget matches on request pathname first (fixes orphaned budgets)", () => {
    const budget = resolveRouteBudget("POST", { pathname: "/api/purchase", label: "purchase" });
    assert.equal(budget, getRouteBudget("POST", "/api/purchase"));
    assert.equal(budget.priority, 0);
  });

  test("resolveRouteBudget falls back to the caller's label for dynamic routes", () => {
    // /api/materials/<id>/publish has no static budget key — only the
    // "material-publish" label used by withApiHardening does.
    const budget = resolveRouteBudget("POST", {
      pathname: "/api/materials/507f1f77bcf86cd799439011/publish",
      label: "material-publish",
    });
    assert.equal(budget, ROUTE_BUDGETS["POST:material-publish"]);
    assert.equal(budget.priority, 1);
  });

  test("resolveRouteBudget returns the default budget when neither pathname nor label match", () => {
    const budget = resolveRouteBudget("GET", { pathname: "/api/does-not-exist", label: "nope" });
    assert.equal(budget.priority, 2);
    assert.equal(budget.maxConcurrent, 20);
  });

  test("resolveRouteBudget handles missing lookup info without throwing", () => {
    const budget = resolveRouteBudget("GET", {});
    assert.ok(budget);
    assert.equal(budget.priority, 2);
  });
});

describe("Abuse protection (#100) — newly protected route budgets", () => {
  test("funds-moving flows (checkout, purchase, refunds) are priority 0", () => {
    const criticalKeys = [
      "GET:/api/purchase",
      "POST:/api/checkout/initiate",
      "POST:/api/checkout/refund",
      "POST:/api/admin/refunds/approve",
    ];
    for (const key of criticalKeys) {
      const budget = ROUTE_BUDGETS[key];
      assert.ok(budget, `Missing budget for ${key}`);
      assert.equal(budget.priority, 0, `${key} should be priority 0 (critical)`);
    }
  });

  test("admin and material state-transition routes have tight concurrency limits", () => {
    const stateTransitionKeys = [
      "POST:/api/admin/users/suspend",
      "PATCH:/api/admin/disputes",
      "POST:/api/admin/verification",
      "POST:material-publish",
    ];
    for (const key of stateTransitionKeys) {
      const budget = ROUTE_BUDGETS[key];
      assert.ok(budget, `Missing budget for ${key}`);
      assert.ok(budget.maxConcurrent <= 10, `${key} should have a tight concurrency cap`);
      assert.ok(budget.maxPayloadBytes > 0 && budget.maxPayloadBytes <= 16_384, `${key} should cap payload size`);
    }
  });

  test("student verification (application creation) allows document upload payload but stays low-concurrency", () => {
    const budget = ROUTE_BUDGETS["POST:/api/verification/student"];
    assert.ok(budget);
    assert.ok(budget.maxPayloadBytes >= 5 * 1024 * 1024, "must fit the 5MB document + form overhead");
    assert.ok(budget.maxConcurrent <= 5, "application creation should be tightly bounded");
  });

  test("all newly added budgets have the required fields", () => {
    const requiredFields = ["maxConcurrent", "maxQueueDepth", "timeoutMs", "maxPayloadBytes", "priority"];
    for (const [key, budget] of Object.entries(ROUTE_BUDGETS)) {
      for (const field of requiredFields) {
        assert.ok(field in budget, `${key} missing ${field}`);
        assert.ok(typeof budget[field] === "number", `${key}.${field} should be a number`);
      }
    }
  });
});
