import { getContext } from "@/lib/telemetry/context";

/**
 * Race a promise against a deadline, with optional external abort signal.
 *
 * If both a timeout and an external signal are provided, whichever fires
 * first wins — the other timer/listener is cleaned up to avoid leaks.
 *
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label  — used in the timeout error message for diagnostics
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 * @template T
 */
export function withTimeout(promise, ms, label, { signal } = {}) {
  if (ms <= 0) {
    return promise;
  }

  let timer;
  let abortListener;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const ctx = getContext();
      const correlationId = ctx?.correlationId || null;
      const err = new Error(`Request timed out after ${ms}ms for ${label}`);
      err.name = "TimeoutError";
      err.correlationId = correlationId;
      reject(err);
    }, ms);
  });

  const externalAbort = signal
    ? new Promise((_, reject) => {
        abortListener = () => {
          const err = new Error(`Request aborted for ${label}: external signal`);
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) {
          abortListener();
        } else {
          signal.addEventListener("abort", abortListener, { once: true });
        }
      })
    : null;

  const race = externalAbort ? Promise.race([promise, timeout, externalAbort]) : Promise.race([promise, timeout]);

  const cleanup = () => {
    clearTimeout(timer);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  };

  race.then(cleanup, cleanup);
  return race;
}
