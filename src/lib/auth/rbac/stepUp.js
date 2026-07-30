import { auditLog } from "../../api/audit.js";

const STEP_UP_TTL_MS = 15 * 60 * 1000;

const pendingStepUps = new Map();

export function recordPendingStepUp(sessionId, meta = {}) {
  pendingStepUps.set(sessionId, {
    ...meta,
    requestedAt: Date.now(),
  });
}

export function consumePendingStepUp(sessionId) {
  const meta = pendingStepUps.get(sessionId);
  if (!meta) return null;
  if (Date.now() - meta.requestedAt > STEP_UP_TTL_MS) {
    pendingStepUps.delete(sessionId);
    return null;
  }
  pendingStepUps.delete(sessionId);
  return meta;
}

export class StepUpRequired extends Error {
  constructor({ action, resource, expiresIn = STEP_UP_TTL_MS } = {}) {
    super("Recent step-up authentication is required");
    this.name = "StepUpRequired";
    this.code = "step_up_required";
    this.status = 428;
    this.action = action;
    this.resource = resource;
    this.expiresIn = expiresIn;
  }
}

export function requireStepUp(request, options = {}) {
  const sessionId = request?.userId || request?.fullUser?._id || "anonymous";
  const pending = consumePendingStepUp(sessionId);
  if (!pending) {
    auditLog({
      event: "step_up_required",
      actor: request?.userId,
      route: options.route,
      action: options.action,
      resource: options.resource,
    });
    throw new StepUpRequired({ action: options.action, resource: options.resource });
  }

  auditLog({
    event: "step_up_consumed",
    actor: request?.userId,
    route: options.route,
    action: options.action,
    resource: options.resource,
  });

  return pending;
}
