import jwt from "jsonwebtoken";

/**
 * Mints a real HS256 JWT identical in shape to `generateAccessToken`
 * (src/lib/auth/tokenService.js) so integration tests can drive routes
 * through the real `getUserFromCookie` -> `verifyDashboardToken` path
 * (src/lib/api/auth.js, src/lib/auth/session.js) instead of bypassing it.
 */
export function signAuthToken(payload, { secret = process.env.JWT_SECRET, expiresIn = 900 } = {}) {
  return jwt.sign(payload, secret, { expiresIn });
}

/** Builds a `Cookie` header value carrying a real, verifiable `auth_token`. */
export function authCookieHeader(payload, options) {
  return `auth_token=${signAuthToken(payload, options)}`;
}

/** Same as authCookieHeader but signs with the wrong secret (tamper simulation). */
export function tamperedAuthCookieHeader(payload, options = {}) {
  return authCookieHeader(payload, { ...options, secret: "wrong-secret-value-not-jwt-secret" });
}

/** Same shape, but already expired (`exp` in the past). */
export function expiredAuthCookieHeader(payload, { secret = process.env.JWT_SECRET } = {}) {
  const token = jwt.sign(payload, secret, { expiresIn: -60 });
  return `auth_token=${token}`;
}
