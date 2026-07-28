import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCircuitBreaker, CircuitState } from "@/lib/resilience/circuitBreaker";

describe("createCircuitBreaker", () => {
  let breaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = createCircuitBreaker("test-dep", {
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeoutMs: 10000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("starts closed", () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("has the correct name", () => {
      expect(breaker.getName()).toBe("test-dep");
    });
  });

  describe("closed state", () => {
    it("calls the function and returns result", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      await expect(breaker.call(fn)).resolves.toBe("ok");
    });

    it("records failures and transitions to open at threshold", () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      // 3 failures should trip the breaker
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("resets failure count on success", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();
      breaker.recordFailure();

      // Should still be closed — success reset the count
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("transitions to open only after reaching threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("propagates errors from the wrapped function", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("boom"));
      await expect(breaker.call(fn)).rejects.toThrow("boom");
    });

    it("counts failures from call() rejections", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("boom"));
      for (let i = 0; i < 3; i++) {
        await expect(breaker.call(fn)).rejects.toThrow("boom");
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe("open state", () => {
    beforeEach(() => {
      // Trip the breaker
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
    });

    it("rejects calls immediately with CircuitBreakerError", async () => {
      const fn = vi.fn().mockResolvedValue("should not reach");
      await expect(breaker.call(fn)).rejects.toThrow("Circuit breaker open for test-dep");
      expect(fn).not.toHaveBeenCalled();
    });

    it("calls fallback when provided instead of rejecting", async () => {
      const fn = vi.fn().mockResolvedValue("should not reach");
      const fallback = vi.fn().mockResolvedValue("fallback value");

      await expect(breaker.call(fn, fallback)).resolves.toBe("fallback value");
      expect(fn).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it("auto-transitions to half_open after reset timeout", () => {
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Advance past reset timeout
      vi.advanceTimersByTime(10000);

      // create a dummy call to trigger transition check
      const fn = vi.fn().mockResolvedValue("probe");
      breaker.call(fn); // don't await, just trigger the state check

      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe("half_open state", () => {
    beforeEach(() => {
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      vi.advanceTimersByTime(10000);
    });

    it("transitions to closed after enough probe successes", () => {
      // Trigger state transition by calling
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("transitions back to open on probe failure", () => {
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("requires successThreshold successes to close", async () => {
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // One more success should close
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("forceState", () => {
    it("forces the breaker into a given state", () => {
      breaker.forceState(CircuitState.OPEN, {});
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      breaker.forceState(CircuitState.CLOSED, {});
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe("onStateChange callback", () => {
    it("calls onStateChange on each transition", () => {
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("test-cb", {
        failureThreshold: 2,
        onStateChange,
      });

      cb.recordFailure();
      cb.recordFailure();
      expect(onStateChange).toHaveBeenCalledWith("test-cb", CircuitState.CLOSED, CircuitState.OPEN);
    });

    it("provides from and to state names", () => {
      const onStateChange = vi.fn();
      const cb = createCircuitBreaker("named-cb", {
        failureThreshold: 2,
        onStateChange,
      });

      cb.recordFailure();
      cb.recordFailure();

      expect(onStateChange).toHaveBeenCalledWith("named-cb", "closed", "open");
    });
  });
});
