/**
 * Tests for the Next.js proxy convention migration — Issue #114
 *
 * Verifies:
 *  1. src/proxy.js exists (file-structure guard).
 *  2. src/middleware.js has been removed.
 *  3. The proxy route matcher is unchanged.
 *  4. isProtectedDashboardPath still correctly classifies dashboard routes
 *     (same helper is used by proxy.js at runtime).
 *
 * Run with: npm run test:backend
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

describe("Proxy convention migration (#114) — file structure", () => {
  test("src/proxy.js exists", () => {
    const proxyPath = path.join(rootDir, "src/proxy.js");
    assert.ok(fs.existsSync(proxyPath), "src/proxy.js should exist");
  });

  test("src/middleware.js has been removed", () => {
    const middlewarePath = path.join(rootDir, "src/middleware.js");
    assert.ok(
      !fs.existsSync(middlewarePath),
      "src/middleware.js should no longer exist after migration to proxy convention"
    );
  });

  test("proxy.js exports a function named 'proxy'", () => {
    const proxyPath = path.join(rootDir, "src/proxy.js");
    const content = fs.readFileSync(proxyPath, "utf-8");
    assert.ok(
      content.includes("export async function proxy"),
      "proxy.js should export 'proxy' function"
    );
  });

  test("proxy.js retains the /dashboard matcher", () => {
    const proxyPath = path.join(rootDir, "src/proxy.js");
    const content = fs.readFileSync(proxyPath, "utf-8");
    assert.ok(
      content.includes('"/dashboard/:path*"'),
      "proxy.js should match /dashboard/:path*"
    );
  });
});

describe("Proxy convention migration (#114) — auth logic", () => {
  test("isProtectedDashboardPath identifies protected routes", async () => {
    const { isProtectedDashboardPath } = await import(
      "../../src/lib/auth/session.js"
    );
    assert.equal(isProtectedDashboardPath("/dashboard"), true);
    assert.equal(isProtectedDashboardPath("/dashboard/upload"), true);
    assert.equal(isProtectedDashboardPath("/dashboard/analytics"), true);
    assert.equal(isProtectedDashboardPath("/marketplace"), false);
    assert.equal(isProtectedDashboardPath("/"), false);
  });
});
