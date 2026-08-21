import { describe, it, expect, vi } from "vitest";
import { verifyEntitlementLogic } from "@/lib/entitlement.js";

// Minimal fake Mongo surface: only what verifyEntitlementLogic touches.
function makeDb({ purchase = null } = {}) {
  return {
    collection(name) {
      if (name !== "purchases") throw new Error(`unexpected collection ${name}`);
      return { findOne: vi.fn().mockResolvedValue(purchase) };
    },
  };
}

describe("verifyEntitlementLogic negative-cache semantics", () => {
  it("caches a chain-confirmed negative result briefly and reports a distinct source", async () => {
    const db = makeDb();
    const setCache = vi.fn().mockResolvedValue(undefined);

    const result = await verifyEntitlementLogic("mat-1", "GBUYER", {
      db,
      checkChain: vi.fn().mockResolvedValue(false), // authoritative "no entitlement"
      getCache: vi.fn().mockResolvedValue(null),
      setCache,
    });

    expect(result).toEqual({ hasAccess: false, source: "chain-miss" });
    expect(setCache).toHaveBeenCalledWith(db, "mat-1", "gbuyer", false, "chain-miss");
  });

  it("does NOT cache a transport failure (null from chain) as a negative result", async () => {
    const db = makeDb();
    const setCache = vi.fn().mockResolvedValue(undefined);

    const result = await verifyEntitlementLogic("mat-1", "GBUYER", {
      db,
      checkChain: vi.fn().mockResolvedValue(null), // RPC failure, not a confirmed miss
      getCache: vi.fn().mockResolvedValue(null),
      setCache,
    });

    // Distinct from an authoritative "not-found" / "chain-miss" - and never written to cache.
    expect(result).toEqual({ hasAccess: false, source: "unavailable" });
    expect(setCache).not.toHaveBeenCalled();
  });

  it("serves a recently-expired positive cache entry while the chain is unreachable (bounded staleness)", async () => {
    const db = makeDb();
    const now = Date.now();
    const cached = {
      active: true,
      source: "chain",
      expiresAt: new Date(now - 60 * 1000), // expired 1 minute ago
    };

    const result = await verifyEntitlementLogic("mat-1", "GBUYER", {
      db,
      checkChain: vi.fn().mockResolvedValue(null),
      getCache: vi.fn().mockResolvedValue(cached),
      setCache: vi.fn(),
    });

    expect(result).toEqual({ hasAccess: true, source: "stale-cache" });
  });

  it("fails closed instead of trusting a positive cache entry indefinitely during a prolonged outage", async () => {
    const db = makeDb();
    const now = Date.now();
    const cached = {
      active: true,
      source: "chain",
      // Expired well beyond the safe grace window (many hours ago).
      expiresAt: new Date(now - 6 * 60 * 60 * 1000),
    };

    const result = await verifyEntitlementLogic("mat-1", "GBUYER", {
      db,
      checkChain: vi.fn().mockResolvedValue(null),
      getCache: vi.fn().mockResolvedValue(cached),
      setCache: vi.fn(),
    });

    expect(result.hasAccess).toBe(false);
    expect(result.source).toBe("unavailable-stale-expired");
  });

  it("safely extends a stale negative cache entry during an outage without risk", async () => {
    const db = makeDb();
    const now = Date.now();
    const cached = {
      active: false,
      source: "chain-miss",
      expiresAt: new Date(now - 6 * 60 * 60 * 1000),
    };

    const result = await verifyEntitlementLogic("mat-1", "GBUYER", {
      db,
      checkChain: vi.fn().mockResolvedValue(null),
      getCache: vi.fn().mockResolvedValue(cached),
      setCache: vi.fn(),
    });

    expect(result).toEqual({ hasAccess: false, source: "stale-cache-miss" });
  });

  it("grants access from a fresh positive cache entry without re-checking the chain", async () => {
    const db = makeDb();
    const now = Date.now();
    const cached = {
      active: true,
      source: "chain",
      expiresAt: new Date(now + 60 * 1000),
    };
    const checkChain = vi.fn();

    const result = await verifyEntitlementLogic("mat-1", "GBUYER", {
      db,
      checkChain,
      getCache: vi.fn().mockResolvedValue(cached),
      setCache: vi.fn(),
    });

    expect(result).toEqual({ hasAccess: true, source: "chain" });
    expect(checkChain).not.toHaveBeenCalled();
  });
});
