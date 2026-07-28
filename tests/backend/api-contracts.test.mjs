import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { apiClient } from "../../src/lib/api/apiClient.js";
import {
  enforceApiResponse,
  negotiateApiVersion,
} from "../../src/lib/api/contract.js";
import {
  parseOpenApi,
  validateOpenApi,
  validateRepository,
  findBreakingChanges,
} from "../../scripts/check-api-contracts.mjs";
import {
  PAYLOAD_SCHEMA_VERSION,
  upcastPayload,
} from "../../src/lib/backend/payloadVersions.js";

const source = readFileSync("docs/openapi.yaml", "utf8");

function fixture(extraPath = "", operationExtra = "", version = "1.0.0", migration = "") {
  return `openapi: "3.1.0"
info:
  version: "${version}"
  x-contract-baseline: 1
  x-version-policy:
    support-window-days: 180
  ${migration}
components:
  schemas:
    Example:
      type: object
      properties:
        value: { type: string }
paths:
  /api/example:
    get:
      operationId: getExample
      security: []
      x-api-version: 1
      x-idempotency: none
      x-pagination: none
      x-example: {}
      ${operationExtra}
      responses:
        "200": { description: ok, content: { application/json: { schema: { $ref: "#/components/schemas/Example" } } } }
        default: { $ref: "#/components/responses/Problem" }
${extraPath}`;
}

test("published operations have complete consumer/provider contracts", () => {
  assert.deepEqual(validateRepository(source), []);
  const first = parseOpenApi(source);
  const second = parseOpenApi(source);
  assert.deepEqual([...first.operations.keys()], [...second.operations.keys()]);
  assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20}/);
});

test("compatibility classifies additive, deprecated, and breaking fixtures", () => {
  const base = parseOpenApi(fixture());
  const additive = parseOpenApi(fixture(`  /api/added:
    get:
      operationId: getAdded
      security: []
      x-api-version: 1
      x-idempotency: none
      x-pagination: none
      x-example: {}
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object } } } }
        default: { $ref: "#/components/responses/Problem" }`));
  const deprecated = parseOpenApi(fixture("", "deprecated: true\n      x-sunset: 2027-01-01\n      x-successor: /api/added\n      x-removal-version: 2"));
  const removed = parseOpenApi(fixture().replace(/  \/api\/example:[\s\S]*/, ""));
  assert.deepEqual(findBreakingChanges(base, additive), []);
  assert.deepEqual(findBreakingChanges(base, parseOpenApi(fixture().replace(
    "        value: { type: string }",
    "        value: { type: string }\n        optional: { type: boolean }",
  ))), []);
  assert.deepEqual(validateOpenApi(deprecated), []);
  assert.deepEqual(findBreakingChanges(base, deprecated), []);
  assert.match(findBreakingChanges(base, removed)[0], /removed/);
  assert.match(findBreakingChanges(base, parseOpenApi(fixture().replace("type: string", "type: integer")))[0], /changed type/);
  assert.deepEqual(findBreakingChanges(base, parseOpenApi(fixture("", "", "2.0.0", "x-migration: docs/v2.md"))), []);
});

test("request version negotiation is deterministic under fuzzed input", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 10_000 }), async (version) => {
    const request = new Request("https://eduvault.test/api/materials", {
      headers: { "x-api-version": String(version), "x-correlation-id": "corr-test" },
    });
    const response = negotiateApiVersion(request, "corr-test");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "unsupported_api_version");
  }));
  assert.equal(negotiateApiVersion(new Request("https://eduvault.test/api/materials"), "old-client"), null);
});

test("response boundary normalizes errors and blocks sensitive or undocumented data", async () => {
  const request = new Request("https://eduvault.test/api/materials");
  const normalized = await enforceApiResponse(
    Response.json({ error: "Bad input" }, { status: 400 }),
    { request, correlationId: "corr-test" },
  );
  assert.equal(normalized.headers.get("content-type"), "application/problem+json");
  assert.deepEqual(await normalized.json(), {
    type: "https://eduvault.invalid/problems/invalid_request",
    title: "Bad Request",
    status: 400,
    detail: "Bad input",
    instance: "/api/materials",
    code: "invalid_request",
    correlationId: "corr-test",
  });
  await assert.rejects(() => enforceApiResponse(Response.json({ passwordHash: "secret" }), { request }));
  await assert.rejects(() => enforceApiResponse(Response.json({ expected: true, extra: true }), {
    request,
    responseKeys: ["expected"],
  }));
});

test("deprecation headers and client version compatibility are enforced", async () => {
  const request = new Request("https://eduvault.test/api/materials");
  const deprecated = await enforceApiResponse(Response.json({ ok: true }), {
    request,
    deprecation: { sunset: "Thu, 01 Jan 2027 00:00:00 GMT", successor: "/api/v2/materials" },
  });
  assert.equal(deprecated.headers.get("deprecation"), "true");
  assert.match(deprecated.headers.get("link"), /successor-version/);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_endpoint, config) => {
      assert.equal(config.headers["X-API-Version"], "1");
      return Response.json({ ok: true }); // New client remains compatible with an old v1 server.
    };
    assert.deepEqual(await apiClient("/api/materials"), { ok: true });
    globalThis.fetch = async () => Response.json({ ok: true }, { headers: { "API-Version": "2" } });
    await assert.rejects(() => apiClient("/api/materials"), { code: "unsupported_api_version" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy and current durable payloads coexist while future versions fail closed", () => {
  const identity = { toString: () => "workflow-id" };
  const workflow = upcastPayload("workflow", { _id: identity, type: "purchase" });
  const event = upcastPayload("outbox", { type: "send_purchase_webhook" });
  assert.equal(workflow.schemaVersion, PAYLOAD_SCHEMA_VERSION);
  assert.equal(workflow._id, identity);
  assert.deepEqual(event.payload, {});
  assert.deepEqual(upcastPayload("workflow", { schemaVersion: 1, metadata: { current: true } }).metadata, { current: true });
  assert.throws(() => upcastPayload("outbox", { schemaVersion: 2 }), /Unsupported/);
});
