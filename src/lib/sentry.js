/**
 * Sentry integration for EduVault (#82).
 *
 * Wraps the @sentry/nextjs package with a thin layer that:
 *  - Is a no-op when SENTRY_DSN is not configured (safe for local dev / CI).
 *  - Strips PII (email, password, full user objects) before sending events.
 *  - Attaches wallet address as a non-PII identifier on the Sentry scope.
 *
 * Sentry is optional. If @sentry/nextjs is not installed, this module silently
 * operates in no-op mode. The dynamic import() is intentional: webpack/Next
 * cannot statically resolve a dynamic import, so no "Module not found" build
 * warning is emitted when the package is absent.
 *
 * Usage:
 *   import { captureException, captureMessage, setSentryUser } from "@/lib/sentry";
 */

// Lazy ESM import — resolved at runtime, invisible to the webpack static analyser.
// This replaces the previous `require("@sentry/nextjs")` which caused a build-time
// "Module not found" warning when @sentry/nextjs was not installed.
let _sentryPromise = null;

async function getSentry() {
  if (_sentryPromise) return _sentryPromise;
  const sentryPackage = "@sentry/nextjs";
  _sentryPromise = import(/* webpackIgnore: true */ /* @vite-ignore */ sentryPackage).catch(() => null);
  return _sentryPromise;
}

function isEnabled() {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Scrub common PII fields before they reach Sentry.
 * Wallet addresses are retained because they are pseudonymous identifiers
 * needed for debugging, not personally identifiable information.
 */
function scrubContext(extra = {}) {
  const DENY = new Set(["email", "password", "name", "phone", "address", "ip"]);
  const safe = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!DENY.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Attach the current user's wallet address to the Sentry scope.
 * Call this as early as possible in authenticated request handlers.
 *
 * @param {string | null} walletAddress  — 56-char Stellar public key or null to clear
 */
export async function setSentryUser(walletAddress) {
  if (!isEnabled()) return;
  const Sentry = await getSentry();
  if (!Sentry) return;
  if (walletAddress) {
    Sentry.setUser({ id: walletAddress });
  } else {
    Sentry.setUser(null);
  }
}

/**
 * Capture an unexpected exception and send it to Sentry.
 *
 * @param {unknown}  error   — the caught error
 * @param {object}   [extra] — additional context (PII is stripped automatically)
 */
export async function captureException(error, extra = {}) {
  if (!isEnabled()) {
    console.error("[sentry:captureException]", error, extra);
    return;
  }
  const Sentry = await getSentry();
  if (!Sentry) {
    console.error("[sentry:captureException]", error, extra);
    return;
  }
  Sentry.withScope((scope) => {
    scope.setExtras(scrubContext(extra));
    Sentry.captureException(error);
  });
}

/**
 * Capture an informational or warning message.
 *
 * @param {string} message
 * @param {"fatal"|"error"|"warning"|"info"|"debug"} [level]
 * @param {object} [extra]
 */
export async function captureMessage(message, level = "info", extra = {}) {
  if (!isEnabled()) {
    console.warn("[sentry:captureMessage]", level, message, extra);
    return;
  }
  const Sentry = await getSentry();
  if (!Sentry) {
    console.warn("[sentry:captureMessage]", level, message, extra);
    return;
  }
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setExtras(scrubContext(extra));
    Sentry.captureMessage(message);
  });
}
