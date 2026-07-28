
import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { errorResponse } from "@/lib/api/errorResponse";
import { validateAuth } from "@/lib/auth/session";
import { getOnboardingState } from "@/lib/auth/roleProvisioning";
import { isIdentityDisabled } from "@/lib/auth/identityService";

export const dynamic = "force-dynamic";

/**
 * Bootstrap endpoint - single source of truth for client initialization.
 * Replaces scattered client-side checks with a server-authoritative endpoint.
 * 
 * Returns:
 * - Auth status (authenticated/not)
 * - User info if authenticated
 * - Onboarding state if onboarding in progress
 * - Role if provisioned
 * - Disabled status if account is disabled
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "auth-bootstrap", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        // 1. Validate auth
        const auth = await validateAuth(request);
        if (!auth.valid) {
          return NextResponse.json({
            authenticated: false,
            reason: auth.reason || "not_authenticated",
          });
        }
        
        // 2. Check if identity is disabled
        const disabled = await isIdentityDisabled(auth.address);
        if (disabled) {
          return NextResponse.json({
            authenticated: true,
            disabled: true,
            reason: "account_disabled",
          });
        }
        
        // 3. Get onboarding state
        const onboarding = await getOnboardingState(auth.address);
        
        // 4. Build response
        const response = {
          authenticated: true,
          user: {
            id: auth.payload.sub,
            walletAddress: auth.address,
            email: auth.payload.email || null,
            name: auth.payload.name || null,
          },
        };
        
        if (onboarding) {
          response.onboarding = {
            state: onboarding.state,
            selectedRole: onboarding.selectedRole || null,
            provider: onboarding.provider || null,
          };
          
          if (onboarding.state === "provisioned") {
            response.user.role = onboarding.selectedRole;
          }
        }
        
        return NextResponse.json(response);
      } catch (error) {
        return errorResponse("Bootstrap error", 500);
      }
    }
  );
}
