import { auditLog } from "../../api/audit.js";
import { ROLE_DEFAULTS } from "./roles.js";

const EMERGENCY_TTL_MS = 2 * 60 * 60 * 1000;
const activeEmergencies = new Map();

export class EmergencyAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmergencyAccessError";
    this.code = "emergency_access_error";
    this.status = 403;
  }
}

export function grantEmergencyAccess({ actor, role, scope, reason }) {
  const defaults = ROLE_DEFAULTS[role];
  if (!defaults?.allowEmergency) {
    throw new EmergencyAccessError("Role is not eligible for emergency access");
  }

  const grant = {
    actor,
    role,
    scope,
    reason,
    grantedAt: Date.now(),
    expiresAt: Date.now() + EMERGENCY_TTL_MS,
    alerted: false,
  };

  const id = `${actor}:${Date.now()}`;
  activeEmergencies.set(id, grant);

  auditLog({
    event: "emergency_access_granted",
    actor,
    role,
    scope,
    reason,
    emergencyId: id,
  });

  return { id, ...grant, ttlMs: EMERGENCY_TTL_MS };
}

export function revokeEmergencyAccess(emergencyId, actor) {
  const grant = activeEmergencies.get(emergencyId);
  if (!grant) return false;

  auditLog({
    event: "emergency_access_revoked",
    actor,
    emergencyId,
    role: grant.role,
    scope: grant.scope,
  });

  activeEmergencies.delete(emergencyId);
  return true;
}

export function requireEmergencyAccess(emergencyId) {
  const grant = activeEmergencies.get(emergencyId);
  if (!grant) {
    throw new EmergencyAccessError("Emergency grant is missing or revoked");
  }
  if (Date.now() > grant.expiresAt) {
    activeEmergencies.delete(emergencyId);
    auditLog({
      event: "emergency_access_expired",
      actor: grant.actor,
      emergencyId,
      role: grant.role,
    });
    throw new EmergencyAccessError("Emergency grant has expired");
  }
  if (!grant.alerted) {
    grant.alerted = true;
    auditLog({
      event: "emergency_access_alert",
      actor: grant.actor,
      emergencyId,
      role: grant.role,
      scope: grant.scope,
    });
  }
  return grant;
}

export function listActiveEmergencies() {
  const now = Date.now();
  return Array.from(activeEmergencies.entries())
    .filter(([, grant]) => now <= grant.expiresAt)
    .map(([id, grant]) => ({ id, ...grant }));
}
