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
});
