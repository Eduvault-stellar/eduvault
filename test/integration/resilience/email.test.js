import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitState } from "@/lib/resilience/circuitBreaker";

vi.mock("@/lib/telemetry/metrics", () => ({ setGauge: vi.fn(), incrementCounter: vi.fn() }));
vi.mock("@/lib/telemetry/context", () => ({ currentTraceparent: vi.fn() }));
vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: vi.fn().mockResolvedValue("ok"), verify: vi.fn().mockResolvedValue("ok") })) },
}));

describe("Email resilience", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports getEmailCircuitBreakerState", async () => {
    const { getEmailCircuitBreakerState } = await import("@/lib/email");
    const state = getEmailCircuitBreakerState();
    expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(state);
  });

  it("sendWelcomeEmail succeeds", async () => {
    const { sendWelcomeEmail } = await import("@/lib/email");
    process.env.EMAIL_USER = "test@test.com";
    process.env.EMAIL_PASS = "pass";
    await expect(sendWelcomeEmail("to@test.com", "Test")).resolves.toBeUndefined();
  });

  it("verifyEmailConnection succeeds", async () => {
    const { verifyEmailConnection } = await import("@/lib/email");
    process.env.EMAIL_USER = "test@test.com";
    process.env.EMAIL_PASS = "pass";
    await expect(verifyEmailConnection()).resolves.toBeUndefined();
  });
});
