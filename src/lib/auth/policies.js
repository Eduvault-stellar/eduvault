import { hasPermission } from "./rbac/permissions.js";

export function isAdmin(payload) {
  return payload && (payload.role === "admin" || payload.role === "super_admin");
}

export function isPayoutProvider(payload) {
  return payload && (payload.role === "payout_provider" || payload.role === "admin" || payload.role === "super_admin");
}

export function isGrantee(payload) {
  return payload && (payload.role === "grantee" || payload.role === "admin" || payload.role === "super_admin");
}

export function isOwner(userId, resourceOwnerId) {
  if (!userId || !resourceOwnerId) {
    return false;
  }
  return userId.toLowerCase() === resourceOwnerId.toLowerCase();
}
