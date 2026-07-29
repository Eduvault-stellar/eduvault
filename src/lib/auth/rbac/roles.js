export const ROLE_HIERARCHY = Object.freeze({
  super_admin: ["admin", "moderator", "payout_provider", "grantee", "user", "service"],
  admin: ["moderator", "payout_provider", "grantee", "user", "service"],
  moderator: ["user", "service"],
  payout_provider: ["service"],
  grantee: ["user", "service"],
  user: ["service"],
  service: [],
});

export const ROLES = Object.freeze(Object.keys(ROLE_HIERARCHY));

export const ROLE_DEFAULTS = Object.freeze({
  super_admin: { label: "Super Admin", maxSessionAgeMs: 15 * 60 * 1000, requireStepUp: true, allowEmergency: true },
  admin: { label: "Admin", maxSessionAgeMs: 15 * 60 * 1000, requireStepUp: true, allowEmergency: true },
  moderator: { label: "Moderator", maxSessionAgeMs: 30 * 60 * 1000, requireStepUp: false, allowEmergency: false },
  payout_provider: { label: "Payout Provider", maxSessionAgeMs: 60 * 60 * 1000, requireStepUp: false, allowEmergency: false },
  grantee: { label: "Grantee", maxSessionAgeMs: 60 * 60 * 1000, requireStepUp: false, allowEmergency: false },
  user: { label: "User", maxSessionAgeMs: 24 * 60 * 60 * 1000, requireStepUp: false, allowEmergency: false },
  service: { label: "Service", maxSessionAgeMs: 60 * 60 * 1000, requireStepUp: false, allowEmergency: false },
});

export function hasRoleHierarchy(actorRole, requiredRole) {
  if (actorRole === requiredRole) return true;
  const inherited = ROLE_HIERARCHY[actorRole] || [];
  return inherited.includes(requiredRole);
}

export function isServiceRole(role) {
  return role === "service";
}
