import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRateLimit } from "../../src/lib/api/rateLimit.js";

// checkRateLimit is async (Redis-backed via a Lua script) and, with no
// REDIS_URL configured (the case here and in CI), always takes the "Redis
// unavailable" fallback path — governed by `outagePolicy`, not an in-memory
// counter. There is no synchronous/deterministic request-counting behavior
// to test without a live Redis instance, so these tests cover the fallback
// contract instead: fail closed by default, fail open when explicitly asked.

test("checkRateLimit fails closed (blocks) when Redis is unavailable and outagePolicy is 'closed' (default)", async () => {
  const result = await checkRateLimit("profile:local", { limit: 2 });
  assert.equal(result.allowed, false);
  assert.equal(result.degraded, true);
});

test("checkRateLimit fails open (allows) when Redis is unavailable and outagePolicy is 'open'", async () => {
  const result = await checkRateLimit("profile:local", { limit: 2, outagePolicy: "open" });
  assert.equal(result.allowed, true);
  assert.equal(result.degraded, true);
import { checkRateLimit, hashedDimension, resetRateLimits } from "../../src/lib/api/rateLimit.js";

/**
 * The rate limiter moved from a module-local Map to a Redis-backed counter
 * (#58), which made `checkRateLimit` async. The previous test still called it
 * synchronously and read `.allowed` off the returned Promise, so it asserted
 * `undefined === true` and had been failing ever since.
 *
 * Redis is not available in unit tests, so what is verifiable here is the
 * behaviour when it is unreachable — which is the security-relevant half:
 * whether an outage fails open or closed.
 */

test("fails closed when Redis is unreachable", async () => {
  resetRateLimits();

  const result = await checkRateLimit("profile:local", { limit: 2 });

  assert.equal(result.allowed, false, "an unreachable limiter must not admit traffic by default");
  assert.equal(result.degraded, true);
  assert.equal(result.remaining, 0);
  assert.ok(result.retryAfter >= 1);
});

test("fails open only when the caller explicitly opts in", async () => {
  resetRateLimits();

  const result = await checkRateLimit("profile:local", { limit: 5, outagePolicy: "open" });

  assert.equal(result.allowed, true);
  assert.equal(result.degraded, true, "an opt-in open failure must still be reported as degraded");
  assert.equal(result.limit, 5);
});

test("hashedDimension does not leak the raw identifier", () => {
  const address = "GBUYER0000000000000000000000000000000000000000000000000A";
  const hashed = hashedDimension(address);

  assert.equal(hashed.length, 32);
  assert.match(hashed, /^[0-9a-f]{32}$/);
  assert.ok(!hashed.includes(address));
  assert.equal(hashed, hashedDimension(address), "hashing must be stable across calls");
  assert.notEqual(hashed, hashedDimension("GOTHER"), "distinct dimensions must not collide");
});

test("missing and empty dimensions collapse to a single anonymous bucket", () => {
  assert.equal(hashedDimension(undefined), hashedDimension("anonymous"));
  assert.equal(hashedDimension(""), hashedDimension("anonymous"));
});
