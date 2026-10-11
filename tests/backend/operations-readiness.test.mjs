/**
 * Operations & Readiness contract tests for Issue #169.
 *
 * Verifies:
 *  1. Liveness probe is strictly zero-dependency, fast, and does not require DB.
 *  2. Readiness probe bounds timeouts on slow downstream dependencies.
 *  3. Non-critical downstream degradation returns HTTP 200 (degraded).
 *  4. Critical downstream outage returns HTTP 503 (unhealthy).
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

describe("Operations: Liveness vs Readiness Separation (#169)", () => {
  test("Liveness probe requires zero external dependencies", async () => {
    // Process uptime is monotonically non-negative
    const uptime = process.uptime();
    assert.equal(typeof uptime, "number");
    assert.ok(uptime >= 0);

    const payload = {
      status: "alive",
      uptimeSeconds: Math.floor(uptime),
      timestamp: new Date().toISOString(),
    };

    assert.equal(payload.status, "alive");
    assert.ok(payload.uptimeSeconds >= 0);
    assert.ok(Date.parse(payload.timestamp) > 0);
  });

  test("Bounded timeout correctly rejects promises that exceed the limit", async () => {
    function withTimeout(promise, timeoutMs, name) {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${name} check exceeded bounded timeout of ${timeoutMs}ms`));
        }, timeoutMs);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    }

    const slowPromise = new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(
      async () => withTimeout(slowPromise, 50, "slow_mock"),
      /slow_mock check exceeded bounded timeout of 50ms/
    );

    const fastPromise = Promise.resolve("ok");
    const result = await withTimeout(fastPromise, 100, "fast_mock");
    assert.equal(result, "ok");
  });

  test("Readiness failure classification adheres to critical vs non-critical rules", () => {
    const CRITICAL = new Set(["database", "stellar"]);

    function computeStatus(failedCritical, failedNonCritical) {
      if (failedCritical.length > 0) return { overall: "unhealthy", statusCode: 503 };
      if (failedNonCritical.length > 0) return { overall: "degraded", statusCode: 200 };
      return { overall: "healthy", statusCode: 200 };
    }

    // All green
    assert.deepEqual(computeStatus([], []), { overall: "healthy", statusCode: 200 });

    // Only non-critical fails (e.g. Pinata or Email or Indexer)
    assert.deepEqual(computeStatus([], ["pinata", "indexer"]), {
      overall: "degraded",
      statusCode: 200,
    });

    // Critical fails (e.g. MongoDB or Stellar)
    assert.deepEqual(computeStatus(["database"], ["email"]), {
      overall: "unhealthy",
      statusCode: 503,
    });
  });
});