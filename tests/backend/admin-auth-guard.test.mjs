import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  isAdmin,
  verifyAdminRequest,
  ADMIN_DENIAL_REASONS,
} from "../../src/lib/auth/adminAuth.js";

import { getUserFromCookie } from "../../src/lib/api/auth.js";

import {
  getMetricsSnapshot,
  resetMetrics,
} from "../../src/lib/telemetry/metrics.js";

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function createTestJwt(payload, secret, { exp } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now };

  if (typeof exp === "number") {
    body.exp = exp;
  } else if (exp !== null) {
    body.exp = now + 3600;
  }

  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(body));
  const signature = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");

  return `${headerPart}.${payloadPart}.${signature}`;
}

function createMockRequest({ headers = {} } = {}) {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
    },
  };
}

const sessionFor = (overrides = {}) => ({
  sub: "507f1f77bcf86cd799439011",
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  ...overrides,
});

const profileFor = (overrides = {}) => ({
  _id: "507f1f77bcf86cd799439011",
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  role: "admin",
  ...overrides,
});

function captureConsoleInfo() {
  const calls = [];
  const original = console.info;
  console.info = (...args) => calls.push(args);
  return {
    calls,
    restore() {
      console.info = original;
    },
  };
}

beforeEach(() => {
  resetMetrics();
});

describe("isAdmin (regression: no defaulting, no trust of caller-supplied data)", () => {
  test("missing or invalid admin data fails closed instead of defaulting to admin", () => {
    // Regression for #134: the previous guard substituted `{ role: "admin" }`
    // whenever a `user` prop was absent, so protected UI rendered without any
    // server-verified identity.
    assert.equal(isAdmin(null), false);
    assert.equal(isAdmin(undefined), false);
    assert.equal(isAdmin({}), false);
    assert.equal(isAdmin({ role: "user" }), false);
    assert.equal(isAdmin({ role: "moderator" }), false);
    assert.equal(isAdmin({ role: "ADMIN" }), false);
    assert.equal(isAdmin("admin"), false);
  });

  test("accepts explicit server-managed admin and super_admin roles", () => {
    assert.equal(isAdmin({ role: "admin" }), true);
    assert.equal(isAdmin({ role: "super_admin" }), true);
  });
});

describe("verifyAdminRequest (server-verified authorization)", () => {
  test("denies requests without a verifiable request shape (fails closed)", async () => {
    const decision = await verifyAdminRequest(null);
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, ADMIN_DENIAL_REASONS.MALFORMED_REQUEST);
    assert.equal(decision.status, 401);

    const noHeaders = await verifyAdminRequest({});
    assert.equal(noHeaders.authorized, false);
    assert.equal(noHeaders.reason, ADMIN_DENIAL_REASONS.MALFORMED_REQUEST);
  });

  test("denies unauthenticated requests (no session cookie)", async () => {
    const decision = await verifyAdminRequest(
      createMockRequest({ headers: {} }),
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, ADMIN_DENIAL_REASONS.UNAUTHENTICATED);
    assert.equal(decision.status, 401);
  });

  test("denies stale (expired) sessions using real session verification", async () => {
    const secret = "test-secret-for-stale-session";
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = secret;

    // Never resolves a profile: if the session itself is stale, the guard must
    // not even reach the profile lookup.
    const deps = {
      getFullUserFromCookie: async () => {
        assert.fail("profile lookup must not run for an expired session");
      },
    };

    try {
      const expired = createTestJwt(sessionFor(), secret, {
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      const decision = await verifyAdminRequest(
        createMockRequest({ headers: { cookie: `auth_token=${expired}` } }),
        deps,
      );
      assert.equal(decision.authorized, false);
      assert.equal(decision.reason, ADMIN_DENIAL_REASONS.UNAUTHENTICATED);
      assert.equal(decision.status, 401);
    } finally {
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });

  test("denies when session verification throws (partial failure)", async () => {
    const decision = await verifyAdminRequest(
      createMockRequest({ headers: { cookie: "auth_token=bad.token.here" } }),
      {
        getUserFromCookie: async () => {
          throw new Error("session service unavailable");
        },
        getFullUserFromCookie: async () => {
          assert.fail("profile lookup must not run after session error");
        },
      },
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, ADMIN_DENIAL_REASONS.SESSION_ERROR);
  });

  test("denies when the verified session has no matching profile record", async () => {
    const decision = await verifyAdminRequest(
      createMockRequest({ headers: {} }),
      {
        getUserFromCookie: async () => sessionFor(),
        getFullUserFromCookie: async () => null,
      },
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, ADMIN_DENIAL_REASONS.PROFILE_NOT_FOUND);
  });

  test("denies when profile lookup fails (partial failure)", async () => {
    const decision = await verifyAdminRequest(
      createMockRequest({ headers: {} }),
      {
        getUserFromCookie: async () => sessionFor(),
        getFullUserFromCookie: async () => {
          throw new Error("database unavailable");
        },
      },
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, ADMIN_DENIAL_REASONS.PROFILE_LOOKUP_ERROR);
  });

  test("denies a server-verified session whose profile role is not admin", async () => {
    const decision = await verifyAdminRequest(
      createMockRequest({ headers: {} }),
      {
        getUserFromCookie: async () => sessionFor(),
        getFullUserFromCookie: async () => profileFor({ role: "user" }),
      },
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, ADMIN_DENIAL_REASONS.NOT_ADMIN);
    assert.equal(decision.status, 403);
  });

  test("grants only after a verified session + admin profile resolution", async () => {
    const fullUser = profileFor({ role: "admin" });
    const decision = await verifyAdminRequest(
      createMockRequest({ headers: {} }),
      {
        getUserFromCookie: async () => sessionFor(),
        getFullUserFromCookie: async () => fullUser,
      },
    );
    assert.equal(decision.authorized, true);
    assert.equal(decision.status, 200);
    assert.equal(decision.user, fullUser);
  });

  test("is idempotent and race-safe under duplicated and concurrent calls", async () => {
    const fullUser = profileFor({ role: "super_admin" });
    const deps = {
      getUserFromCookie: async () => sessionFor(),
      getFullUserFromCookie: async () => fullUser,
    };
    const request = createMockRequest({ headers: {} });

    const first = await verifyAdminRequest(request, deps);
    const second = await verifyAdminRequest(request, deps);
    assert.equal(first.authorized, true);
    assert.equal(second.authorized, true);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyAdminRequest(request, deps)),
    );
    for (const result of results) {
      assert.equal(result.authorized, true);
      assert.equal(result.user, fullUser);
    }

    const snapshot = getMetricsSnapshot();
    const granted = snapshot.counters?.admin_guard_granted_total;
    assert.ok(granted, "expected admin_guard_granted_total metric");
    assert.equal(granted[""], 22); // 2 sequential + 20 concurrent grants
  });

  test("records bounded, PII-free metrics and audit entries on denial", async () => {
    const capture = captureConsoleInfo();
    try {
      await verifyAdminRequest(createMockRequest({ headers: {} }), {
        getUserFromCookie: async () => sessionFor({
          email: "admin@example.test", // must never appear in logs
          walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        }),
        getFullUserFromCookie: async () => profileFor({ role: "user" }),
      });

      const snapshot = getMetricsSnapshot();
      const denied = snapshot.counters?.admin_guard_denied_total;
      assert.ok(denied, "expected admin_guard_denied_total metric");
      assert.ok(denied['reason="not_admin"'], "expected a bounded reason label");

      const auditLines = capture.calls
        .map((args) => args.join(" "))
        .join("\n");
      assert.match(auditLines, /admin_guard_denied/);
      assert.match(auditLines, /not_admin/);
      assert.doesNotMatch(auditLines, /admin@example\.test/);
      assert.doesNotMatch(auditLines, /GAAAAAAAAAAAAAAAAAAAA/);
    } finally {
      capture.restore();
    }
  });
});