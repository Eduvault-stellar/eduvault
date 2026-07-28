import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitState } from "@/lib/resilience/circuitBreaker";

vi.mock("@/lib/telemetry/metrics", () => ({ setGauge: vi.fn(), incrementCounter: vi.fn() }));
vi.mock("@/lib/telemetry/context", () => ({ currentTraceparent: vi.fn(() => "00-abc-xyz-01") }));

describe("Webhook resilience", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports getWebhookCircuitBreakerState", async () => {
    const { getWebhookCircuitBreakerState } = await import("@/lib/webhooks/dispatcher");
    const state = getWebhookCircuitBreakerState();
    expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(state);
  });

  it("dispatchWebhook validates HTTPS", async () => {
    const { dispatchWebhook } = await import("@/lib/webhooks/dispatcher");
    await expect(dispatchWebhook("http://example.com", "{}")).rejects.toThrow("Only HTTPS is allowed");
  });

  it("dispatchWebhook validates port", async () => {
    const { dispatchWebhook } = await import("@/lib/webhooks/dispatcher");
    await expect(dispatchWebhook("https://example.com:8080", "{}")).rejects.toThrow("Unsafe port");
  });
});
