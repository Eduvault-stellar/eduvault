/**
 * Shared client-address trust gate for anything that keys behavior (rate
 * limits, audit logs) off the caller's network address.
 *
 * X-Forwarded-For and X-Real-IP are client-suppliable headers — trusting
 * them unconditionally lets a direct client spoof its own identity (to
 * dodge rate limiting) or someone else's (to get them blocked). They are
 * only honored when TRUST_PROXY=true, which operators set once requests
 * are known to arrive through a proxy/CDN that overwrites these headers
 * with the real client address (e.g. Vercel's edge network).
 *
 * Kept dependency-free (no next/server import) so it can be unit tested
 * directly under plain Node — proxy.js and lib/api/hardening.js both pull
 * in "next/server", which only resolves inside Next's own bundler.
 */
export function resolveTrustedClientIp(request, { fallback = "anonymous" } = {}) {
  if (process.env.TRUST_PROXY !== "true") {
    return fallback;
  }
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || fallback;
}
