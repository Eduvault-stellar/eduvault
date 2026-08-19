import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

import { describe, it, expect, vi, beforeEach } from "vitest";

const requestMock = vi.fn();

vi.mock("node:https", () => ({
  default: { request: (...args) => requestMock(...args) },
}));

vi.mock("node:dns/promises", () => ({
  default: { lookup: async () => ({ address: "93.184.216.34", family: 4 }) },
}));

const { dispatchWebhook, RESPONSE_LIMITS } = await import("../dispatcher.js");

/**
 * Drive `dispatchWebhook` against a scripted subscriber response.
 *
 * @param {{ statusCode?: number, headers?: object, chunks?: Array<Buffer|string> }} script
 */
function respondWith({ statusCode = 200, headers = {}, chunks = [] }) {
  requestMock.mockImplementation((options, callback) => {
    const req = new EventEmitter();
    req.write = () => true;
    req.destroy = vi.fn();
    req.end = () => {
      const res = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8"))));
      res.statusCode = statusCode;
      res.headers = headers;
      setImmediate(() => callback(res));
    };
    return req;
  });
}

describe("dispatchWebhook response handling (#173)", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("regression: does not hand back the raw subscriber body or raw headers", async () => {
    const body = JSON.stringify({
      status: "ok",
      session_id: "sid_live_0123456789abcdef",
      user: "learner@example.com",
    });

    respondWith({
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": ["sid=super-secret-value; HttpOnly"],
        "x-request-id": "req-7",
      },
      chunks: [body],
    });

    const response = await dispatchWebhook("https://hooks.example.com/hook", "{}", "sig");
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain("sid_live_0123456789abcdef");
    expect(serialized).not.toContain("learner@example.com");
    expect(serialized).not.toContain("super-secret-value");
    expect(response.responseHeaders).toEqual({
      "content-type": "application/json",
      "x-request-id": "req-7",
    });
    expect(response.responseBody).toContain("ok");
    expect(response.responseBodyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(response.status).toBe(200);
  });

  it("bounds an oversized body without failing the delivery", async () => {
    const oversized = "x".repeat(RESPONSE_LIMITS.maxReadBytes * 2);
    respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      chunks: [oversized.slice(0, oversized.length / 2), oversized.slice(oversized.length / 2)],
    });

    const response = await dispatchWebhook("https://hooks.example.com/hook", "{}", null);

    expect(response.status).toBe(200);
    expect(response.responseBodyTruncated).toBe(true);
    expect(response.responseBody.length).toBeLessThanOrEqual(
      RESPONSE_LIMITS.previewChars + "[TRUNCATED]".length,
    );
    expect(response.responseBodyBytes).toBeGreaterThan(RESPONSE_LIMITS.maxReadBytes);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const encoded = Buffer.from('{"m":"héllo"}', "utf8");
    // Split inside the two-byte sequence for "é".
    const splitAt = encoded.indexOf(Buffer.from("é", "utf8")) + 1;

    respondWith({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      chunks: [encoded.subarray(0, splitAt), encoded.subarray(splitAt)],
    });

    const response = await dispatchWebhook("https://hooks.example.com/hook", "{}", null);
    expect(response.responseBody).toContain("héllo");
  });

  it("digests but does not preview non-allowlisted content types", async () => {
    respondWith({
      statusCode: 500,
      headers: { "content-type": "text/html" },
      chunks: ["<html><body>session=abc</body></html>"],
    });

    const response = await dispatchWebhook("https://hooks.example.com/hook", "{}", null);

    expect(response.responseBody).toBe("");
    expect(response.responseBodyOmittedReason).toBe("content_type_not_allowlisted");
    expect(response.responseBodyDigest).toMatch(/^sha256:/);
  });

  it("propagates stream errors instead of resolving with a partial body", async () => {
    requestMock.mockImplementation((options, callback) => {
      const req = new EventEmitter();
      req.write = () => true;
      req.destroy = vi.fn();
      req.end = () => {
        const res = new Readable({ read() {} });
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        setImmediate(() => {
          callback(res);
          res.emit("data", Buffer.from('{"partial":'));
          res.emit("error", new Error("socket hang up"));
        });
      };
      return req;
    });

    await expect(dispatchWebhook("https://hooks.example.com/hook", "{}", null)).rejects.toThrow(
      "socket hang up",
    );
  });
});
