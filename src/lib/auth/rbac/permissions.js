import { ROLES, ROLE_DEFAULTS } from "./roles.js";

export const PERMISSION_MATRIX = Object.freeze({
  "users:suspend": {
    roles: ["admin", "super_admin"],
    denySelf: true,
    stepUp: true,
    dualApproval: true,
    risk: "high",
    resourceType: "user",
    description: "Suspend or reactivate user accounts",
  },
  "users:read": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "low",
    resourceType: "user",
    description: "Read user profiles",
  },
  "refunds:approve": {
    roles: ["admin", "super_admin"],
    denySelf: true,
    stepUp: true,
    dualApproval: true,
    risk: "high",
    resourceType: "refund",
    description: "Approve on-chain refunds",
  },
  "refunds:read": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "low",
    resourceType: "refund",
    description: "View refund records",
  },
  "verification:decide": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: true,
    stepUp: true,
    dualApproval: false,
    risk: "medium",
    resourceType: "verification",
    description: "Approve or reject verification applications",
  },
  "verification:read": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "low",
    resourceType: "verification",
    description: "View verification applications",
  },
  "disputes:resolve": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: true,
    stepUp: true,
    dualApproval: false,
    risk: "medium",
    resourceType: "dispute",
    description: "Resolve disputes",
  },
  "disputes:read": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "low",
    resourceType: "dispute",
    description: "View disputes",
  },
  "materials:manage": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "medium",
    resourceType: "material",
    description: "Manage any material",
  },
  "payouts:manage": {
    roles: ["admin", "super_admin", "payout_provider"],
    denySelf: true,
    stepUp: true,
    dualApproval: true,
    risk: "high",
    resourceType: "payout",
    description: "Trigger or modify payouts",
  },
  "emergency:access": {
    roles: ["super_admin"],
    denySelf: true,
    stepUp: true,
    dualApproval: true,
    risk: "critical",
    resourceType: "system",
    description: "Grant emergency break-glass access",
  },
  "service:heartbeat": {
    roles: ["service"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "low",
    resourceType: "system",
    description: "Service health heartbeat",
  },
  "admin:read": {
    roles: ["admin", "super_admin", "moderator"],
    denySelf: false,
    stepUp: false,
    dualApproval: false,
    risk: "low",
    resourceType: "admin",
    description: "Access admin area",
  },
});

export function getPermission(action) {
  return PERMISSION_MATRIX[action] || null;
}

export function hasPermission(role, action) {
  const permission = PERMISSION_MATRIX[action];
  if (!permission) return false;
  if (role === "super_admin") return true;
  return permission.roles.includes(role);
}
