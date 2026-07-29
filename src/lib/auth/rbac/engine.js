import { getContext } from "../../telemetry/context.js";
import { auditLog, createAuditEntry } from "../../api/audit.js";
import { hasRoleHierarchy, isServiceRole, ROLE_DEFAULTS } from "./roles.js";
import { getPermission, hasPermission } from "./permissions.js";
import { requireStepUp, recordPendingStepUp, StepUpRequired } from "./stepUp.js";
import { createDualApprovalRequest, requireDualApproval, DualApprovalRequired } from "./dualApproval.js";

export class AuthorizationError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.status = status;
  }
}

export function recordAuthzDecision(fields) {
  const context = getContext();
  const entry = createAuditEntry({
    ...fields,
    correlationId: context?.correlationId,
    traceId: context?.traceId,
    route: context?.route,
  });
  console.info(JSON.stringify(entry));
  return entry;
}

async function resolveResourceOwner(request, resourceType, resourceId) {
  if (!resourceType || !resourceId || typeof request.userId !== "string") return null;

  try {
    if (resourceType === "user") {
      return resourceId;
    }

    const db = await import("../../mongodb.js").then((m) => m.getDb());
    if (!db) return null;

    if (resourceType === "refund") {
      const doc = await db.collection("refunds").findOne({ _id: resourceId });
      return doc?.buyerAddress ? String(doc.buyerAddress).toLowerCase() : null;
    }

    if (resourceType === "verification") {
      const doc = await db.collection("verification_applications").findOne({ _id: resourceId });
      return doc?.userUuid ? String(doc.userUuid).toLowerCase() : null;
    }

    if (resourceType === "material") {
      const doc = await db.collection("materials").findOne({ materialId: resourceId });
      return doc?.creatorAddress ? String(doc.creatorAddress).toLowerCase() : null;
    }
  } catch {
    return null;
  }

  return null;
}

export async function evaluatePolicy({
  request,
  action,
  resource,
  resourceId,
  context = {},
}) {
  const actor = request?.userId;
  const actorRole = request?.fullUser?.role;

  if (!actor || !actorRole) {
    const entry = recordAuthzDecision({
      event: "authz_denied",
      action,
      resource,
      resourceId,
      outcome: "denied",
      reason: "unauthenticated",
    });
    throw new AuthorizationError("unauthenticated", "Authentication required", 401);
  }

  const permission = getPermission(action);
  if (!permission) {
    const entry = recordAuthzDecision({
      event: "authz_denied",
      actor,
      role: actorRole,
      action,
      resource,
      resourceId,
      outcome: "denied",
      reason: "unknown_action",
    });
    throw new AuthorizationError("unknown_action", `Action ${action} is not defined in the permission matrix`, 403);
  }

  const isService = isServiceRole(actorRole);
  const hasRole = hasPermission(actorRole, action);
  const inherited = hasRoleHierarchy(actorRole, permission.roles[0]);

  if (!hasRole || !inherited) {
    const entry = recordAuthzDecision({
      event: "authz_denied",
      actor,
      role: actorRole,
      action,
      resource,
      resourceId,
      outcome: "denied",
      reason: "missing_role",
    });
    throw new AuthorizationError("missing_role", "Forbidden: insufficient role permissions", 403);
  }

  if (isService && context.impersonating) {
    const entry = recordAuthzDecision({
      event: "authz_denied",
      actor,
      role: actorRole,
      action,
      resource,
      resourceId,
      outcome: "denied",
      reason: "service_impersonation_blocked",
    });
    throw new AuthorizationError("service_impersonation_blocked", "Service identities cannot impersonate users", 403);
  }

  const ownerId = await resolveResourceOwner(request, permission.resourceType, resourceId);
  if (permission.denySelf && ownerId && actor.toLowerCase() === ownerId.toLowerCase()) {
    const entry = recordAuthzDecision({
      event: "authz_denied",
      actor,
      role: actorRole,
      action,
      resource,
      resourceId,
      outcome: "denied",
      reason: "self_action_denied",
    });
    throw new AuthorizationError("self_action_denied", "Forbidden: sensitive actions on own resources require dual approval", 403);
  }

  const policyVersion = 1;
  const entry = recordAuthzDecision({
    event: "authz_allowed",
    actor,
    role: actorRole,
    action,
    resource,
    resourceId,
    outcome: "allowed",
    policyVersion,
    reason: "policy_match",
  });

  return {
    allowed: true,
    policyVersion,
    reason: "policy_match",
    auditEntry: entry,
    requiresStepUp: permission.stepUp,
    requiresDualApproval: permission.dualApproval,
    risk: permission.risk,
  };
}

export async function enforcePolicy(request, decision, options = {}) {
  if (!decision || !decision.allowed) {
    throw new AuthorizationError("policy_denied", "Policy evaluation denied access", 403);
  }

  if (decision.requiresStepUp) {
    try {
      requireStepUp(request, {
        route: options.route,
        action: options.action,
        resource: options.resource,
      });
    } catch (error) {
      if (error instanceof StepUpRequired) {
        throw {
          type: "step_up_required",
          code: error.code,
          action: error.action,
          resource: error.resource,
          expiresIn: error.expiresIn,
          status: error.status,
        };
      }
      throw error;
    }
  }

  if (decision.requiresDualApproval) {
    const approvalId = options.approvalId || request.headers?.get?.("x-dual-approval-id");
    if (!approvalId) {
      const approval = createDualApprovalRequest({
        action: options.action,
        resource: options.resource,
        resourceId: options.resourceId,
        actor: request.userId,
        payload: options.payload,
      });
      throw {
        type: "dual_approval_required",
        code: "dual_approval_required",
        approvalId: approval.id,
        requiredApprovers: approval.requiredApprovers,
        status: 428,
      };
    }

    try {
      requireDualApproval(approvalId, request.userId);
    } catch (error) {
      if (error instanceof DualApprovalRequired) {
        throw {
          type: "dual_approval_required",
          code: error.code,
          approvalId,
          requiredApprovers: error.requiredApprovers,
          status: error.status,
        };
      }
      throw error;
    }
  }

  return decision;
}

export function withRBAC(options = {}) {
  return async (request, action, resource, resourceId) => {
    const decision = await evaluatePolicy({ request, action, resource, resourceId, context: options });
    return enforcePolicy(request, decision, { ...options, action, resource, resourceId });
  };
}

export async function authorizeRequest(request, action, resource, resourceId) {
  return evaluatePolicy({ request, action, resource, resourceId });
}
