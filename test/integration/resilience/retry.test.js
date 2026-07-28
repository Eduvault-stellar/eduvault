import { describe, it, expect, vi } from "vitest";
import { withRetry, defaultIsTransientError } from "@/lib/resilience/retry";

// Small base delay so tests don't wait long with real timers
const FAST = { baseDelayMs: 1, maxDelayMs: 10 };

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { idempotent: true })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }))
      .mockRejectedValueOnce(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }))
      .mockResolvedValue("recovered");

    await expect(withRetry(fn, { idempotent: true, ...FAST })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  }, 15000);

  it("stops retrying after maxAttempts and throws last error", async () => {
    const error = Object.assign(new Error("persistent"), { code: "ECONNRESET" });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { idempotent: true, maxAttempts: 3, ...FAST })).rejects.toThrow("persistent");
    expect(fn).toHaveBeenCalledTimes(3);
  }, 15000);

  it("does not retry on non-transient errors", async () => {
    const error = new Error("bad request");
    error.status = 400;
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { idempotent: true, maxAttempts: 3 })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry when idempotent is false (default)", async () => {
    const error = Object.assign(new Error("transient"), { code: "ECONNRESET" });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow("transient");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries when idempotent is true, even for transient errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("transient"), { code: "ECONNRESET" }))
      .mockResolvedValue("ok");

    await expect(withRetry(fn, { idempotent: true, ...FAST })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  }, 15000);

  it("calls onRetry callback with attempt info before each delay", async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("fail1"), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("fail2"), { code: "ECONNRESET" }))
      .mockResolvedValue("ok");

    await withRetry(fn, {
      idempotent: true,
      maxAttempts: 3,
      ...FAST,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.objectContaining({ message: "fail1" }), expect.any(Number));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.objectContaining({ message: "fail2" }), expect.any(Number));
  }, 15000);

  it("uses custom isTransientError predicate", async () => {
    const isTransient = vi.fn().mockReturnValue(false);
    const fn = vi.fn().mockRejectedValue(new Error("custom transient"));

    await expect(withRetry(fn, { idempotent: true, isTransientError: isTransient })).rejects.toThrow("custom transient");
    expect(isTransient).toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxAttempts = 1 (no retry)", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("fail"), { code: "ECONNRESET" }));

    await expect(withRetry(fn, { idempotent: true, maxAttempts: 1 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("defaultIsTransientError", () => {
  it("returns true for 429 status", () => {
    const err = new Error("rate limited");
    err.status = 429;
    expect(defaultIsTransientError(err)).toBe(true);
  });

  it("returns true for 503 status", () => {
    const err = new Error("unavailable");
    err.status = 503;
    expect(defaultIsTransientError(err)).toBe(true);
  });

  it("returns true for ECONNRESET code", () => {
    const err = new Error("connection reset");
    err.code = "ECONNRESET";
    expect(defaultIsTransientError(err)).toBe(true);
  });

  it("returns true for TimeoutError name", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(defaultIsTransientError(err)).toBe(true);
  });

  it("returns false for 400 status", () => {
    const err = new Error("bad request");
    err.status = 400;
    expect(defaultIsTransientError(err)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(defaultIsTransientError(null)).toBe(false);
    expect(defaultIsTransientError(undefined)).toBe(false);
  });

  it("detects timeout in error message", () => {
    const err = new Error("request timed out");
    expect(defaultIsTransientError(err)).toBe(true);
  });

  it("detects network in error message", () => {
    const err = new Error("network error");
    expect(defaultIsTransientError(err)).toBe(true);
  });
});
