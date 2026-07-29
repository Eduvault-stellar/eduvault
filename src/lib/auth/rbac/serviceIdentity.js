import { isServiceRole } from "./roles.js";

export function isServiceIdentity(payload) {
  if (!payload || typeof payload !== "object") return false;
  return isServiceRole(payload.role);
}

export function getServicePermissions(serviceId) {
  return {
    maxConcurrency: 4,
    allowedActions: ["service:heartbeat", "service:status"],
    denyImpersonation: true,
  };
}

export function assertNotImpersonating(actorPayload) {
  if (isServiceIdentity(actorPayload)) {
    throw new Error("Service identities cannot impersonate users");
  }
}

export function assertServiceCaller(actorPayload) {
  if (!isServiceIdentity(actorPayload)) {
    throw new Error("Expected service identity");
  }
}
