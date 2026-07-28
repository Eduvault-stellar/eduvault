import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitState } from "@/lib/resilience/circuitBreaker";

vi.mock("@/lib/telemetry/metrics", () => ({ setGauge: vi.fn(), incrementCounter: vi.fn() }));
vi.mock("@/lib/telemetry/context", () => ({ currentTraceparent: vi.fn() }));
vi.mock("pinata", () => ({
  PinataSDK: vi.fn().mockImplementation(function() {
    return {
      testAuthentication: vi.fn(),
      upload: { public: { file: vi.fn(), json: vi.fn() } },
      gateways: { public: { convert: vi.fn() } },
      unpin: vi.fn(),
    };
  }),
}));

describe("Pinata resilience", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports getPinataCircuitBreakerState", async () => {
    const { getPinataCircuitBreakerState } = await import("@/lib/pinata");
    const state = getPinataCircuitBreakerState();
    expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(state);
  });

  it("callPinata wraps with CB and returns result on success", async () => {
    const { callPinata } = await import("@/lib/pinata");
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(callPinata("test", fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("callPinata throws DependencyError when CB is open", async () => {
    const mod = await import("@/lib/pinata");
    for (let i = 0; i < 3; i++) {
      try { await mod.callPinata("test", () => Promise.reject(new Error("fail"))); } catch {}
    }
    const err = await mod.callPinata("test", () => Promise.resolve("ok")).catch(e => e);
    expect(err.name).toBe("DependencyError");
    expect(err.userMessage).toBe("Storage service is temporarily unavailable.");
  });

  it("exports original pinata instance", async () => {
    const { pinata } = await import("@/lib/pinata");
    expect(pinata).toBeDefined();
  });
});
