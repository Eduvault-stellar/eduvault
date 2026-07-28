import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout } from "@/lib/resilience/timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves successfully when promise completes before deadline", async () => {
    const promise = Promise.resolve("ok");
    await expect(withTimeout(promise, 1000, "test")).resolves.toBe("ok");
  });

  it("rejects with TimeoutError when promise exceeds deadline", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 2000));
    const result = withTimeout(slow, 100, "test");

    vi.advanceTimersByTime(100);

    await expect(result).rejects.toThrow("timed out after 100ms");
    await expect(result).rejects.toHaveProperty("name", "TimeoutError");
  });

  it("returns resolved value when deadline matches exactly", async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve("exact"), 50));
    const result = withTimeout(promise, 100, "test");

    vi.advanceTimersByTime(50);

    await expect(result).resolves.toBe("exact");
  });

  it("returns the promise result immediately when ms is 0 or negative", async () => {
    await expect(withTimeout(Promise.resolve("fast"), 0, "test")).resolves.toBe("fast");
    await expect(withTimeout(Promise.resolve("fast"), -1, "test")).resolves.toBe("fast");
  });

  it("rejects immediately when external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const promise = new Promise((resolve) => setTimeout(resolve, 1000));
    const result = withTimeout(promise, 5000, "test", { signal: controller.signal });

    await expect(result).rejects.toThrow("external signal");
    await expect(result).rejects.toHaveProperty("name", "AbortError");
  });

  it("rejects on external signal before timeout", async () => {
    const controller = new AbortController();
    const promise = new Promise((resolve) => setTimeout(resolve, 2000));
    const result = withTimeout(promise, 5000, "test", { signal: controller.signal });

    // Fire abort before timeout
    controller.abort();

    await expect(result).rejects.toThrow("external signal");
  });

  it("rejects on timeout before external signal", async () => {
    const controller = new AbortController();
    const promise = new Promise((resolve) => setTimeout(resolve, 2000));
    const result = withTimeout(promise, 100, "test", { signal: controller.signal });

    vi.advanceTimersByTime(100);

    await expect(result).rejects.toThrow("timed out after 100ms");
    // Signal didn't fire — verify controller not aborted
    expect(controller.signal.aborted).toBe(false);
  });

  it("removes abort listener on completion to avoid leaks", async () => {
    const controller = new AbortController();
    const spy = vi.fn();

    const promise = Promise.resolve("ok");
    await withTimeout(promise, 1000, "test", { signal: controller.signal });

    // Create a new listener to verify the old one was removed
    controller.signal.addEventListener("abort", spy);
    controller.abort();
    expect(spy).toHaveBeenCalledTimes(1); // only the new listener fired
  });

  it("removes abort listener on timeout to avoid leaks", async () => {
    const controller = new AbortController();
    const spy = vi.fn();

    const promise = new Promise((resolve) => setTimeout(resolve, 2000));
    const result = withTimeout(promise, 100, "test", { signal: controller.signal });

    vi.advanceTimersByTime(100);
    await expect(result).rejects.toThrow("timed out");

    controller.signal.addEventListener("abort", spy);
    controller.abort();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("propagates the promise rejection when it fails before deadline", async () => {
    const failing = Promise.reject(new Error("business logic error"));
    await expect(withTimeout(failing, 1000, "test")).rejects.toThrow("business logic error");
  });

  it("includes the label in the timeout error message", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 2000));
    const result = withTimeout(slow, 50, "my-label");

    vi.advanceTimersByTime(50);

    await expect(result).rejects.toThrow("my-label");
  });

  it("handles multiple concurrent timeouts independently", async () => {
    const fast = new Promise((resolve) => setTimeout(() => resolve("fast"), 50));
    const slow = new Promise((resolve) => setTimeout(() => resolve("slow"), 200));

    const resultFast = withTimeout(fast, 100, "fast");
    const resultSlow = withTimeout(slow, 100, "slow");

    vi.advanceTimersByTime(50);
    // fast should resolve
    await expect(resultFast).resolves.toBe("fast");

    vi.advanceTimersByTime(50);
    // slow should time out
    await expect(resultSlow).rejects.toThrow("timed out after 100ms for slow");
  });
});
