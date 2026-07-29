import { authenticateRequest } from "./requestAuth";
import { NextResponse } from "next/server";
import { getFullUserFromCookie } from "@/lib/api/auth";
import { authorizeRequest, evaluatePolicy, enforcePolicy, AuthorizationError } from "./rbac/engine";

export async function authorize(request, options = {}) {
  const {
    public: isPublic = false,
    adminOnly = false,
    payoutProviderOnly = false,
    granteeOnly = false,
    checkOwnership,
    rbacAction,
    rbacResource,
    rbacResourceId,
    enforceRbac = false,
  } = options;

  if (isPublic) {
    return { isAuthorized: true };
  }

  const authResult = await authenticateRequest(request);

  if (!authResult.isAuthenticated) {
    return {
      isAuthorized: false,
      response: NextResponse.json(
        { error: authResult.reason || "Authentication required" },
        { status: authResult.status }
      ),
    };
  }

  const { userId, payload: userPayload } = authResult;

  const fullUser = await getFullUserFromCookie(request);
  if (!fullUser) {
    return {
      isAuthorized: false,
      response: NextResponse.json(
        { error: "User profile not found" },
        { status: 401 }
      ),
    };
  }

  if (adminOnly && fullUser.role !== "admin" && fullUser.role !== "super_admin") {
    return {
      isAuthorized: false,
      response: NextResponse.json(
        { error: "Forbidden: Administrator access required" },
        { status: 403 }
      ),
    };
  }

  if (payoutProviderOnly && fullUser.role !== "payout_provider" && fullUser.role !== "admin" && fullUser.role !== "super_admin") {
    return {
      isAuthorized: false,
      response: NextResponse.json(
        { error: "Forbidden: Payout provider access required" },
        { status: 403 }
      ),
    };
  }

  if (granteeOnly && fullUser.role !== "grantee" && fullUser.role !== "admin" && fullUser.role !== "super_admin") {
    return {
      isAuthorized: false,
      response: NextResponse.json(
        { error: "Forbidden: Grantee access required" },
        { status: 403 }
      ),
    };
  }

  if (checkOwnership) {
    const isOwnerOfResource = await checkOwnership(userId, fullUser, request);
    if (!isOwnerOfResource) {
      return {
        isAuthorized: false,
        response: NextResponse.json(
          { error: "Forbidden: Resource ownership required" },
          { status: 403 }
        ),
      };
    }
  }

  if (rbacAction) {
    try {
      const policyDecision = await authorizeRequest(
        request,
        rbacAction,
        rbacResource,
        rbacResourceId
      );

      if (enforceRbac) {
        try {
          await enforcePolicy(request, policyDecision, {
            route: options.route,
            action: rbacAction,
            resource: rbacResource,
            resourceId: rbacResourceId,
            payload: options.payload,
          });
        } catch (error) {
          if (error && error.type) {
            const status = error.status || 403;
            return {
              isAuthorized: false,
              response: NextResponse.json(
                { error: error.code || "forbidden", ...error },
                { status }
              ),
            };
          }
          throw error;
        }
      }

      request.rbacDecision = policyDecision;
    } catch (error) {
      const status = error.status || 403;
      return {
        isAuthorized: false,
        response: NextResponse.json(
          { error: error.message || "Forbidden", code: error.code || "rbac_error" },
          { status }
        ),
      };
    }
  }

  return {
    isAuthorized: true,
    userId,
    userPayload,
    fullUser,
  };
}

export function withAuthorization(handler, options) {
  return async (request, ...args) => {
    const authResult = await authorize(request, options);

    if (!authResult.isAuthorized) {
      return authResult.response;
    }

    request.userId = authResult.userId;
    request.userPayload = authResult.userPayload;
    request.fullUser = authResult.fullUser;

    return handler(request, ...args);
  };
}
