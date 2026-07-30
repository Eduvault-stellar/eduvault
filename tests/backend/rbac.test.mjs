import assert from "node:assert/strict";
import { test, describe } from "node:test";

const STEP_UP_TTL_MS = 15 * 60 * 1000;

const {
  ROLES,
  ROLE_HIERARCHY,
  ROLE_DEFAULTS,
  hasRoleHierarchy,
  isServiceRole,
  getPermission,
  hasPermission,
  evaluatePolicy,
  AuthorizationError,
  recordAuthzDecision,
  StepUpRequired,
  DualApprovalRequired,
  EmergencyAccessError,
  grantEmergencyAccess,
  revokeEmergencyAccess,
  requireEmergencyAccess,
  listActiveEmergencies,
  isServiceIdentity,
  getServicePermissions,
  assertNotImpersonating,
  requireStepUp,
  recordPendingStepUp,
  consumePendingStepUp,
  createDualApprovalRequest,
  recordDualApproval,
  requireDualApproval,
} = await import("../../src/lib/auth/rbac/index.js");

const fakeRequestFor = (userId, role, fullUser = {}) => ({
  userId,
  fullUser: fullUser.role ? fullUser : { ...fullUser, role },
});

describe("RBACPermissionMatrix", () => {
  test("users:suspend requires admin or super_admin", () => {
    assert.ok(hasPermission("admin", "users:suspend"));
    assert.ok(hasPermission("super_admin", "users:suspend"));
    assert.ok(!hasPermission("user", "users:suspend"));
    assert.ok(!hasPermission("moderator", "users:suspend"));
  });

  test("verification:decide allows admin, super_admin, and moderator", () => {
    assert.ok(hasPermission("moderator", "verification:decide"));
    assert.ok(hasPermission("admin", "verification:decide"));
    assert.ok(!hasPermission("user", "verification:decide"));
  });

  test("refunds:approve includes dual approval and step up", () => {
    const perm = getPermission("refunds:approve");
    assert.ok(perm);
    assert.ok(perm.dualApproval);
    assert.ok(perm.stepUp);
    assert.equal(perm.risk, "high");
  });

  test("users:read is low risk and widely allowed", () => {
    const perm = getPermission("users:read");
    assert.ok(perm);
    assert.ok(!perm.stepUp);
    assert.ok(!perm.dualApproval);
    assert.equal(perm.risk, "low");
  });

  test("returns null for unknown action", () => {
    assert.equal(getPermission("unknown:action"), null);
  });
});

describe("RBACRoleHierarchy", () => {
  test("super_admin inherits admin and below", () => {
    assert.ok(hasRoleHierarchy("super_admin", "admin"));
    assert.ok(hasRoleHierarchy("super_admin", "moderator"));
    assert.ok(hasRoleHierarchy("super_admin", "user"));
  });

  test("admin inherits moderator and below", () => {
    assert.ok(hasRoleHierarchy("admin", "moderator"));
    assert.ok(!hasRoleHierarchy("admin", "super_admin"));
  });

  test("service has no inherited roles", () => {
    assert.ok(!hasRoleHierarchy("service", "user"));
  });

  test("isServiceRole detects service role", () => {
    assert.ok(isServiceRole("service"));
    assert.ok(!isServiceRole("admin"));
  });
});

describe("RBACPolicyEngine", () => {
  test("denies unauthenticated requests", async () => {
    await assert.rejects(
      () => evaluatePolicy({ request: {}, action: "users:read", resource: "user", resourceId: "1" }),
      { code: "unauthenticated", status: 401 }
    );
  });

  test("denies unknown actions", async () => {
    await assert.rejects(
      () => evaluatePolicy({ request: fakeRequestFor("u1", "admin"), action: "foo:bar", resource: "x", resourceId: "1" }),
      { code: "unknown_action" }
    );
  });

  test("allows authorized admin action and identifies step-up requirement", async () => {
    const decision = await evaluatePolicy({
      request: fakeRequestFor("u1", "admin"),
      action: "users:suspend",
      resource: "user",
      resourceId: "other-user",
    });
    assert.ok(decision.allowed);
    assert.ok(decision.requiresStepUp);
    assert.ok(decision.requiresDualApproval);
    assert.equal(decision.risk, "high");
  });

  test("denies self-action on high-risk resources when owner matches actor", async () => {
    await assert.rejects(
      () => evaluatePolicy({
        request: fakeRequestFor("admin-1", "admin", { walletAddress: "admin-1" }),
        action: "users:suspend",
        resource: "user",
        resourceId: "admin-1",
      }),
      { code: "self_action_denied" }
    );
  });

  test("records auditable decision entries", async () => {
    const entry = recordAuthzDecision({
      event: "authz_allowed",
      actor: "u1",
      role: "admin",
      action: "users:read",
      resource: "user",
      resourceId: "u2",
      outcome: "allowed",
      policyVersion: 1,
      reason: "policy_match",
    });
    assert.equal(entry.actor, "u1");
    assert.equal(entry.action, "users:read");
    assert.equal(entry.outcome, "allowed");
    assert.equal(entry.policyVersion, "1");
  });
});

describe("RBACStepUpAuth", () => {
  test("throws StepUpRequired when no pending step-up exists", () => {
    assert.throws(
      () => requireStepUp(fakeRequestFor("u1", "admin"), { action: "users:suspend", resource: "user" }),
      StepUpRequired
    );
  });

  test("consumes pending step-up within TTL", () => {
    recordPendingStepUp("u1", { action: "users:suspend" });
    const meta = consumePendingStepUp("u1");
    assert.ok(meta);
    assert.equal(meta.action, "users:suspend");
  });

  test("expires pending step-up after TTL", () => {
    const sessionId = "u2-expired";
    const pendingMap = new Map();
    pendingMap.set(sessionId, {
      action: "users:suspend",
      requestedAt: Date.now() - STEP_UP_TTL_MS - 1000,
    });
    const cached = pendingMap.get(sessionId);
    assert.ok(cached);
    assert.ok(Date.now() - cached.requestedAt > STEP_UP_TTL_MS);
  });
});

describe("RBACDualApproval", () => {
  test("creates a dual approval request", () => {
    const approval = createDualApprovalRequest({
      action: "refunds:approve",
      resource: "refund",
      resourceId: "r1",
      actor: "u1",
    });
    assert.ok(approval.id);
    assert.equal(approval.requiredApprovers, 2);
  });

  test("rejects self-approval", () => {
    const approval = createDualApprovalRequest({
      action: "refunds:approve",
      resource: "refund",
      resourceId: "r1",
      actor: "u1",
    });
    const updated = recordDualApproval(approval.id, "u1");
    assert.equal(updated, null);
  });

  test("accepts distinct approver and completes at threshold", () => {
    const approval = createDualApprovalRequest({
      action: "refunds:approve",
      resource: "refund",
      resourceId: "r1",
      actor: "u1",
    });
    const first = recordDualApproval(approval.id, "u2");
    assert.ok(first);
    assert.equal(first.approvers.size, 1);
    const completed = recordDualApproval(approval.id, "u3");
    assert.ok(completed);
    assert.equal(completed.approvers.size, 2);
  });
});

describe("RBACServiceIdentity", () => {
  test("detects service identity", () => {
    assert.ok(isServiceIdentity({ role: "service" }));
    assert.ok(!isServiceIdentity({ role: "admin" }));
    assert.ok(!isServiceIdentity(null));
  });

  test("returns narrow service permissions", () => {
    const perms = getServicePermissions("svc-1");
    assert.ok(perms.denyImpersonation);
    assert.ok(Array.isArray(perms.allowedActions));
  });

  test("blocks impersonation for service identity", () => {
    assert.throws(() => assertNotImpersonating({ role: "service" }), /Service identities cannot impersonate/);
    assert.doesNotThrow(() => assertNotImpersonating({ role: "admin" }));
  });
});

describe("RBACEmergencyAccess", () => {
  test("grants time-limited emergency access for eligible role", () => {
    const grant = grantEmergencyAccess({
      actor: "admin-1",
      role: "super_admin",
      scope: "users:suspend",
      reason: "Incident response",
    });
    assert.ok(grant.id);
    assert.ok(grant.expiresAt > grant.grantedAt);
    assert.equal(grant.alerted, false);
  });

  test("rejects emergency access for ineligible role", () => {
    assert.throws(
      () => grantEmergencyAccess({ actor: "u1", role: "user", scope: "system", reason: "x" }),
      EmergencyAccessError
    );
  });

  test("requires active emergency grant and alerts on first use", () => {
    const grant = grantEmergencyAccess({ actor: "admin-1", role: "super_admin", scope: "system", reason: "Incident" });
    const active = requireEmergencyAccess(grant.id);
    assert.ok(active);
    assert.ok(active.alerted);

    const again = requireEmergencyAccess(grant.id);
    assert.ok(again);
  });

  test("lists only active emergencies", () => {
    const active = listActiveEmergencies();
    assert.ok(Array.isArray(active));
    assert.ok(active.length > 0);
  });

  test("revokes emergency access", () => {
    const grant = grantEmergencyAccess({ actor: "admin-1", role: "super_admin", scope: "system", reason: "Incident" });
    const revoked = revokeEmergencyAccess(grant.id, "admin-1");
    assert.ok(revoked);
  });
});

describe("RBACPolicyMatrixScenarios", () => {
  test("horizontal_escalation: user cannot access payout operations", async () => {
    await assert.rejects(
      () => evaluatePolicy({ request: fakeRequestFor("u1", "user"), action: "payouts:manage", resource: "payout", resourceId: "p1" }),
      { code: "missing_role" }
    );
  });

  test("vertical_escalation: moderator cannot approve refunds", async () => {
    await assert.rejects(
      () => evaluatePolicy({ request: fakeRequestFor("m1", "moderator"), action: "refunds:approve", resource: "refund", resourceId: "r1" }),
      { code: "missing_role" }
    );
  });

  test("revoked_role: falls back when role is missing", async () => {
    await assert.rejects(
      () => evaluatePolicy({ request: fakeRequestFor("u1", null), action: "users:read", resource: "user", resourceId: "u2" }),
      { code: "unauthenticated", status: 401 }
    );
  });

  test("self_approval: admin cannot suspend self", async () => {
    await assert.rejects(
      () => evaluatePolicy({
        request: fakeRequestFor("admin-1", "admin", { walletAddress: "admin-1" }),
        action: "users:suspend",
        resource: "user",
        resourceId: "admin-1",
      }),
      { code: "self_action_denied" }
    );
  });

  test("cross_environment: same role works across networks because policy does not block by default", async () => {
    const decision = await evaluatePolicy({
      request: fakeRequestFor("admin-1", "admin"),
      action: "verification:read",
      resource: "verification",
      resourceId: "v1",
    });
    assert.ok(decision.allowed);
  });

  test("confused_deputy: unauthenticated caller without actor is denied", async () => {
    await assert.rejects(
      () => evaluatePolicy({ request: {}, action: "users:read", resource: "user", resourceId: "u1" }),
      { code: "unauthenticated", status: 401 }
    );
  });

  test("service_identity: cannot act while impersonating", async () => {
    await assert.rejects(
      () => evaluatePolicy({
        request: fakeRequestFor("svc-1", "service"),
        action: "service:heartbeat",
        resource: "system",
        resourceId: "svc-1",
        context: { impersonating: true },
      }),
      { code: "service_impersonation_blocked" }
    );
  });

  test("policy_migration: policy version is recorded in decision", async () => {
    const decision = await evaluatePolicy({
      request: fakeRequestFor("admin-1", "admin"),
      action: "verification:read",
      resource: "verification",
      resourceId: "v1",
    });
    assert.ok(decision.allowed);
    assert.equal(decision.policyVersion, 1);
  });
});
