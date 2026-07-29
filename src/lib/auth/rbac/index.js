export { ROLES, ROLE_HIERARCHY, ROLE_DEFAULTS, hasRoleHierarchy, isServiceRole } from "./roles.js";
export { PERMISSION_MATRIX, getPermission, hasPermission } from "./permissions.js";
export {
  evaluatePolicy,
  withRBAC,
  authorizeRequest,
  AuthorizationError,
  recordAuthzDecision,
} from "./engine.js";
export { StepUpRequired, requireStepUp, recordPendingStepUp, consumePendingStepUp } from "./stepUp.js";
export {
  DualApprovalRequired,
  createDualApprovalRequest,
  recordDualApproval,
  requireDualApproval,
} from "./dualApproval.js";
export {
  isServiceIdentity,
  getServicePermissions,
  assertNotImpersonating,
  assertServiceCaller,
} from "./serviceIdentity.js";
export {
  grantEmergencyAccess,
  revokeEmergencyAccess,
  requireEmergencyAccess,
  listActiveEmergencies,
  EmergencyAccessError,
} from "./emergencyAccess.js";
