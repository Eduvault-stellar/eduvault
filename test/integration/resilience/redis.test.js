import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitState } from "@/lib/resilience/circuitBreaker";

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  on: vi.fn(),
  connect: vi.fn().mockResolvedValue(),
};

vi.mock("@/lib/telemetry/metrics", () => ({ setGauge: vi.fn(), incrementCounter: vi.fn() }));
vi.mock("@/lib/telemetry/context", () => ({ currentTraceparent: vi.fn() }));
vi.mock("redis", () => ({ createClient: vi.fn(() => mockRedis) }));

describe("Redis resilience", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  it("exports getRedisCircuitBreakerState", async () => {
    const { getRedisCircuitBreakerState } = await import("@/lib/cache/redis");
    const state = getRedisCircuitBreakerState();
    expect([CircuitState.CLOSED, CircuitState.OPEN, CircuitState.HALF_OPEN]).toContain(state);
  });

  it("cacheGet returns null when key missing", async () => {
    mockRedis.get.mockResolvedValue(null);
    const { cacheGet } = await import("@/lib/cache/redis");
    await expect(cacheGet("missing")).resolves.toBeNull();
  });

  it("cacheGet returns parsed value when key exists", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ foo: "bar" }));
    const { cacheGet } = await import("@/lib/cache/redis");
    await expect(cacheGet("exists")).resolves.toEqual({ foo: "bar" });
  });

  it("cacheSet writes to redis", async () => {
    mockRedis.set.mockResolvedValue("OK");
    const { cacheSet } = await import("@/lib/cache/redis");
    await expect(cacheSet("key", { data: 1 }, 300)).resolves.toBeUndefined();
    expect(mockRedis.set).toHaveBeenCalled();
  });

  it("cacheDel removes key", async () => {
    mockRedis.del.mockResolvedValue(1);
    const { cacheDel } = await import("@/lib/cache/redis");
    await expect(cacheDel("key")).resolves.toBeUndefined();
    expect(mockRedis.del).toHaveBeenCalledWith("key");
  });
});
