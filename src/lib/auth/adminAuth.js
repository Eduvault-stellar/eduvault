// src/lib/auth/adminAuth.js
/**
 * Admin authorization for the EduVault admin UI.
 *
 * Previously this module shipped a client-side higher-order component
 * (`withAdminGuard`) that defaulted a missing `user` prop to an admin role:
 *
 *   const user = props.user || { role: "admin" }; // mock
 *
 * That let protected UI render for visitors whose identity had never been
 * verified by a server. It has been replaced by true server-side, identity-
 * verified authorization that mirrors `src/lib/auth/authorize.js`:
 *
 *   1. The request session is verified from a signed cookie
 *      (`getUserFromCookie`), which rejects malformed, forged and stale
 *      (expired) tokens.
 *   2. The verified session subject is resolved to a database profile
 *      (`getFullUserFromCookie`). A missing or failed lookup denies access.
 *   3. The profile role is checked with `isAdmin` (admin/super_admin).
 *
 * Protected UI (`src/app/admin/*`) is enforced by a Server Component layout
 * (`src/app/admin/layout.jsx`) that calls `verifyAdminRequest` before
 * rendering any child page, so unauthorized content never reaches the client.
 *
 * Compatibility / migration:
 * - `withAdminGuard(PageComponent)` (client HOC) is REMOVED. Any component
 *   importing it must instead rely on the /admin server layout. No persisted
 *   or on-chain data changes; this only changes who may render admin UI.
 * - The `isAdmin` export is preserved and now also accepts the
 *   `super_admin` role, matching the API policy in `src/lib/auth/policies.js`.
 * - Denials are persisted as audit events and recorded as bounded metrics;
 *   no emails, wallet addresses or tokens are logged.
 */
import { auditLog } from "../api/audit.js";
import { getUserFromCookie, getFullUserFromCookie } from "../api/auth.js";
import { isAdmin as isAdminRole } from "./policies.js";
import { incrementCounter } from "../telemetry/metrics.js";

export const ADMIN_DENIAL_REASONS = Object.freeze({
  MALFORMED_REQUEST: "malformed_request",
  UNAUTHENTICATED: "unauthenticated",
  SESSION_ERROR: "session_verification_error",
  PROFILE_NOT_FOUND: "profile_not_found",
  PROFILE_LOOKUP_ERROR: "profile_lookup_error",
  NOT_ADMIN: "not_admin",
});

const DENIAL_STATUS = Object.freeze({
  [ADMIN_DENIAL_REASONS.MALFORMED_REQUEST]: 401,
  [ADMIN_DENIAL_REASONS.UNAUTHENTICATED]: 401,
  [ADMIN_DENIAL_REASONS.SESSION_ERROR]: 401,
  [ADMIN_DENIAL_REASONS.PROFILE_NOT_FOUND]: 401,
  [ADMIN_DENIAL_REASONS.PROFILE_LOOKUP_ERROR]: 401,
  [ADMIN_DENIAL_REASONS.NOT_ADMIN]: 403,
});

export const ADMIN_METRIC_DENIED = "admin_guard_denied_total";
export const ADMIN_METRIC_GRANTED = "admin_guard_granted_total";

/**
 * Strict admin role predicate that fails closed.
 *
 * Unlike the removed mock, this never substitutes a default identity and
 * never trusts a caller-supplied role object alone — it is only evaluated by
 * `verifyAdminRequest` against a profile resolved from a verified session.
 *
 * @param {object|null|undefined} user profile record from the database
 * @returns {boolean}
 */
export function isAdmin(user) {
  return Boolean(isAdminRole(user));
}

function recordMetrics(reason) {
  incrementCounter(ADMIN_METRIC_DENIED, { reason });
}

/**
 * Server-verified admin authorization.
 *
 * Verifies the signed session cookie and resolves the session subject to a
 * database profile before applying the admin role policy. Every failure mode
 * returns `{ authorized: false, reason, status }`; nothing defaults to admin.
 *
 * Dependency injection keeps this testable without JWT/Mongo fixtures while
 * defaulting to the same verified helpers used by the API route layer.
 *
 * @param {*} request Next/undici request-like object (`headers.get` required)
 * @param {object} [deps]
 * @param {Function} [deps.getUserFromCookie] verifies and returns the session
 * @param {Function} [deps.getFullUserFromCookie] resolves a DB profile
 * @returns {Promise<{authorized: true, status: number, user: object, session: object} | {authorized: false, reason: string, status: number}>}
 */
export async function verifyAdminRequest(request, deps = {}) {
  const verifySession = deps.getUserFromCookie || getUserFromCookie;
  const resolveProfile = deps.getFullUserFromCookie || getFullUserFromCookie;

  const malformed =
    !request || !request.headers || typeof request.headers.get !== "function";
  if (malformed) {
    // Metrics-only: anonymous scanners must not be able to flood the audit log.
    return deny(ADMIN_DENIAL_REASONS.MALFORMED_REQUEST, { audit: false });
  }

  let session = null;
  try {
    session = await verifySession(request);
  } catch {
    return deny(ADMIN_DENIAL_REASONS.SESSION_ERROR, { audit: false });
  }

  // No/expired/invalid session: same contract as `authenticateRequest`.
  if (!session) {
    return deny(ADMIN_DENIAL_REASONS.UNAUTHENTICATED, { audit: false });
  }

  // A verified session exists from here on; denials are security-relevant and
  // are retained in the audit log. The session subject is a DB id, not PII,
  // and is allow-listed in the audit schema, so it is attributed where known.
  const actor = session.sub ? String(session.sub) : undefined;
  let fullUser = null;
  try {
    fullUser = await resolveProfile(request);
  } catch {
    return deny(ADMIN_DENIAL_REASONS.PROFILE_LOOKUP_ERROR, {
      audit: true,
      actor,
    });
  }

  if (!fullUser) {
    return deny(ADMIN_DENIAL_REASONS.PROFILE_NOT_FOUND, {
      audit: true,
      actor,
    });
  }

  if (!isAdmin(fullUser)) {
    return deny(ADMIN_DENIAL_REASONS.NOT_ADMIN, {
      audit: true,
      actor,
      role: String(fullUser.role ?? "unknown").slice(0, 300),
    });
  }

  incrementCounter(ADMIN_METRIC_GRANTED);
  return { authorized: true, status: 200, user: fullUser, session };
}

function deny(reason, { audit = true, actor, role } = {}) {
  const status = DENIAL_STATUS[reason] || 500;
  recordMetrics(reason);

  if (audit) {
    const entryFields = {
      event: "admin_guard_denied",
      reason,
      status,
      outcome: "denied",
      scope: "admin-ui",
    };
    if (actor) entryFields.actor = String(actor);
    if (role) entryFields.role = String(role);
    auditLog(entryFields);
  }

  return { authorized: false, reason, status };
}