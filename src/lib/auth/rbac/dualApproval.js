import { auditLog } from "../../api/audit.js";

const DUAL_APPROVAL_TTL_MS = 30 * 60 * 1000;
const pendingApprovals = new Map();

export class DualApprovalRequired extends Error {
  constructor({ action, resource, resourceId, requiredApprovers = 2 } = {}) {
    super("Dual approval is required for this action");
    this.name = "DualApprovalRequired";
    this.code = "dual_approval_required";
    this.status = 428;
    this.action = action;
    this.resource = resource;
    this.resourceId = resourceId;
    this.requiredApprovers = requiredApprovers;
  }
}

export function createDualApprovalRequest({ action, resource, resourceId, actor, payload }) {
  const id = `${resource}:${resourceId}:${ Date.now() }`;
  const approval = {
    id,
    action,
    resource,
    resourceId,
    payload,
    approvers: new Set(),
    requiredApprovers: 2,
    createdAt: Date.now(),
    createdBy: actor,
  };

  pendingApprovals.set(id, approval);
  return approval;
}

export function recordDualApproval(approvalId, approver) {
  const approval = pendingApprovals.get(approvalId);
  if (!approval) return null;
  if (Date.now() - approval.createdAt > DUAL_APPROVAL_TTL_MS) {
    pendingApprovals.delete(approvalId);
    return null;
  }
  if (approval.createdBy === approver) {
    auditLog({
      event: "dual_approval_rejected_self",
      actor: approver,
      approvalId,
      action: approval.action,
      resource: approval.resource,
      resourceId: approval.resourceId,
    });
    return null;
  }
  approval.approvers.add(approver);
  auditLog({
    event: "dual_approval_recorded",
    actor: approver,
    approvalId,
    approvers: Array.from(approval.approvers),
    action: approval.action,
    resource: approval.resource,
    resourceId: approval.resourceId,
  });
  if (approval.approvers.size >= approval.requiredApprovers) {
    pendingApprovals.delete(approvalId);
    return approval;
  }
  return approval;
}

export function requireDualApproval(approvalId, approver) {
  const approval = recordDualApproval(approvalId, approver);
  if (!approval || approval.approvers.size < approval.requiredApprovers) {
    throw new DualApprovalRequired({
      action: approval?.action,
      resource: approval?.resource,
      resourceId: approval?.resourceId,
    });
  }
  return approval;
}
