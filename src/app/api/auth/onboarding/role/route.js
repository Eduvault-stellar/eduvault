import { NextResponse } from "next/server";
import { validateAuth } from "@/lib/auth/session";
import { provisionRole, getOnboardingState } from "@/lib/auth/roleProvisioning";
import { isIdentityDisabled } from "@/lib/auth/identityService";
import { errorResponse } from "@/lib/api/errorResponse";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/onboarding/role
 * 
 * Select and provision a role during onboarding.
 * This is called after the user selects their role (admin, grantee, payoutProvider).
 * 
 * Request body:
 * {
 *   "role": "grantee" | "admin" | "payoutProvider",
 *   "roleData": { ... } // Optional role-specific data
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "user": { ... },
 *   "onboarding": { ... }
 * }
 */
export async function POST(request) {
  try {
    // 1. Validate authentication
    const auth = await validateAuth(request);
    if (!auth.valid) {
      return errorResponse("Unauthorized", 401);
    }

    // 2. Check if identity is disabled
    const disabled = await isIdentityDisabled(auth.address);
    if (disabled) {
      return errorResponse("Account is disabled", 403);
    }

    // 3. Parse request body
    const body = await request.json();
    const { role, roleData = {} } = body;

    // 4. Validate role
    const validRoles = ["admin", "grantee", "payoutProvider"];
    if (!role || !validRoles.includes(role)) {
      return errorResponse(`Invalid role. Must be one of: ${validRoles.join(", ")}`, 400);
    }

    // 5. Check current onboarding state
    const currentState = await getOnboardingState(auth.address);
    
    if (currentState) {
      // If already provisioned, prevent role change
      if (currentState.state === "provisioned") {
        return errorResponse("Role already provisioned. Cannot change role.", 400);
      }
      
      // If already failed, allow retry
      if (currentState.state === "failed") {
        // Allow retry - proceed with provisioning
      }
      
      // If role_selected, allow update if not provisioned
      if (currentState.state === "role_selected" && currentState.selectedRole === role) {
        // Same role selected again - still proceed
      }
    }

    // 6. Provision the role atomically
    const result = await provisionRole(auth.address, role, roleData);

    if (!result.success) {
      return errorResponse(result.error || "Failed to provision role", 500);
    }

    // 7. Return success response
    return NextResponse.json({
      success: true,
      user: {
        id: result.user.uuid,
        walletAddress: result.user.walletAddress,
        email: result.user.email || null,
        name: result.user.displayName || null,
        role: result.user.role,
      },
      onboarding: {
        state: "provisioned",
        selectedRole: result.user.role,
        completedAt: new Date().toISOString(),
      },
    });

  } catch (error) {
    console.error("Role selection error:", error);
    return errorResponse("An unexpected error occurred", 500);
  }
}
