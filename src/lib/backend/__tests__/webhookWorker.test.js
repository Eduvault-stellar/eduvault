import { describe, it, expect, vi, beforeEach } from "vitest";

import { COLLECTIONS } from "@/lib/backend/schemaContracts";

const dispatchWebhook = vi.fn();
const getDb = vi.fn();

vi.mock("@/lib/mongodb", () => ({ getDb: (...args) => getDb(...args) }));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/webhooks/dispatcher", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, dispatchWebhook: (...args) => dispatchWebhook(...args) };
});

const { processWebhookDeliveries } = await import("@/lib/backend/webhookWorker");
const { sanitizeWebhookResponse } = await import("@/lib/webhooks/dispatcher");
const { logger } = await import("@/lib/logger");

/**
 * Minimal in-memory stand-in for the two collections the worker touches.
 * `updates` records every update so assertions can inspect what would be
 * persisted, which is the whole point of these tests.
 */
function createDb({ deliveries = [], webhooks = [] } = {}) {
  const updates = [];

  const collection = (name) => {
    if (name === COLLECTIONS.webhookDeliveries) {
      return {
        find: () => ({
          sort: () => ({
            limit: () => ({ toArray: async () => deliveries }),
          }),
        }),
        updateOne: async (filter, update) => {
          updates.push({ filter, update });
          return { modifiedCount: 1 };
        },
      };
    }
    if (name === COLLECTIONS.webhooks) {
      return {
        findOne: async (filter) => webhooks.find((w) => w._id === filter._id) || null,
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };

  return { db: { collection }, updates };
}

const activeWebhook = {
  _id: "hook-1",
  status: "active",
  url: "https://hooks.example.com/endpoint",
  secrets: [{ id: "s1", key: "topsecret" }],
};

function pendingDelivery(overrides = {}) {
  return {
    _id: "delivery-1",
    webhookId: "hook-1",
    userId: "GBUYER",
    eventId: "evt-1",
    eventType: "purchase.completed",
    payload: { materialId: "mat-1" },
    status: "pending",
    attempts: [],
    ...overrides,
  };
}

function attemptFrom(updates) {
  const pushed = updates.find((u) => u.update.$push);
  return pushed?.update.$push.attempts;
}

describe("webhook worker response persistence (#173)", () => {
  beforeEach(() => {
    dispatchWebhook.mockReset();
    getDb.mockReset();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  it("regression: never persists cookies, tokens or PII from a subscriber response", async () => {
    const rawBody = JSON.stringify({
      ok: true,
      session_id: "sid_live_0123456789abcdef",
      subscriber_email: "learner@example.com",
    });

    dispatchWebhook.mockResolvedValue(
      sanitizeWebhookResponse({
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": ["sid=super-secret-value; HttpOnly"],
          "x-request-id": "req-9",
        },
        bodyBuffer: Buffer.from(rawBody, "utf8"),
      }),
    );

    const { db, updates } = createDb({
      deliveries: [pendingDelivery()],
      webhooks: [activeWebhook],
    });
    getDb.mockResolvedValue(db);

    const processed = await processWebhookDeliveries();
    expect(processed).toBe(1);

    const persisted = JSON.stringify(updates);
    expect(persisted).not.toContain("sid_live_0123456789abcdef");
    expect(persisted).not.toContain("learner@example.com");
    expect(persisted).not.toContain("super-secret-value");

    const attempt = attemptFrom(updates);
    expect(attempt.responseStatus).toBe(200);
    expect(attempt.responseBodyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(attempt.responseBodyBytes).toBe(Buffer.byteLength(rawBody));
    expect(attempt.responseBodyTruncated).toBe(false);
    expect(Object.keys(attempt.responseHeaders).sort()).toEqual(["content-type", "x-request-id"]);
    expect(updates[0].update.$set.status).toBe("success");
  });

  it("does not log the response body, only its size and digest", async () => {
    dispatchWebhook.mockResolvedValue(
      sanitizeWebhookResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyBuffer: Buffer.from('{"secretish":"do-not-log-me"}', "utf8"),
      }),
    );

    const { db } = createDb({ deliveries: [pendingDelivery()], webhooks: [activeWebhook] });
    getDb.mockResolvedValue(db);

    await processWebhookDeliveries();

    const logged = vi.mocked(logger.info).mock.calls.flat().join(" ");
    expect(logged).not.toContain("do-not-log-me");
    expect(logged).toContain("digest=sha256:");
  });

  it("records an oversized, non-previewable response as digest-only and still retries on failure", async () => {
    dispatchWebhook.mockResolvedValue(
      sanitizeWebhookResponse({
        status: 500,
        headers: { "content-type": "text/html" },
        bodyBuffer: Buffer.from("<html>session=leaky</html>", "utf8"),
        bodyBytes: 10 * 1024 * 1024,
        truncated: true,
      }),
    );

    const { db, updates } = createDb({
      deliveries: [pendingDelivery({ attempts: [{ attemptNumber: 1 }] })],
      webhooks: [activeWebhook],
    });
    getDb.mockResolvedValue(db);

    await processWebhookDeliveries();

    const attempt = attemptFrom(updates);
    expect(attempt.responseBody).toBe("");
    expect(attempt.responseBodyOmittedReason).toBe("content_type_not_allowlisted");
    expect(attempt.responseBodyTruncated).toBe(true);
    expect(attempt.error).toBe("HTTP 500");
    expect(JSON.stringify(updates)).not.toContain("session=leaky");

    // Not the final attempt: the delivery is rescheduled rather than parked.
    expect(updates[0].update.$set.nextAttemptAt).toBeInstanceOf(Date);
    expect(updates[0].update.$set.status).toBeUndefined();
  });

  it("redacts dispatch errors before persisting them", async () => {
    dispatchWebhook.mockRejectedValue(
      new Error(
        "connect ECONNREFUSED for https://hooks.example.com/e?access_token=aaaabbbbccccdddd\n    at TCPConnectWrap.done (/srv/app/net.js:10:2)",
      ),
    );

    const { db, updates } = createDb({
      deliveries: [pendingDelivery()],
      webhooks: [activeWebhook],
    });
    getDb.mockResolvedValue(db);

    await processWebhookDeliveries();

    const attempt = attemptFrom(updates);
    expect(attempt.error).toContain("ECONNREFUSED");
    expect(attempt.error).not.toContain("aaaabbbbccccdddd");
    expect(attempt.error).not.toContain("/srv/app/net.js");
  });

  it("parks a delivery in dead_letter on the final attempt", async () => {
    dispatchWebhook.mockRejectedValue(new Error("timeout"));

    const { db, updates } = createDb({
      deliveries: [
        pendingDelivery({
          attempts: [1, 2, 3, 4].map((attemptNumber) => ({ attemptNumber })),
        }),
      ],
      webhooks: [activeWebhook],
    });
    getDb.mockResolvedValue(db);

    await processWebhookDeliveries();

    expect(updates[0].update.$set.status).toBe("dead_letter");
    expect(updates[0].update.$set.nextAttemptAt).toBeNull();
  });

  it("fails a delivery whose webhook is gone or disabled without dispatching", async () => {
    const { db, updates } = createDb({
      deliveries: [pendingDelivery()],
      webhooks: [{ ...activeWebhook, status: "disabled" }],
    });
    getDb.mockResolvedValue(db);

    await processWebhookDeliveries();

    expect(dispatchWebhook).not.toHaveBeenCalled();
    expect(updates[0].update.$set.status).toBe("failed");
  });
});
