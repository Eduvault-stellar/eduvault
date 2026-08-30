import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  verifyAdminRequest,
  ADMIN_DENIAL_REASONS,
} from "@/lib/auth/adminAuth";

export const dynamic = "force-dynamic";

function AccessDenied() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <section className="text-center max-w-md px-6 py-12" aria-live="polite">
        <h1 className="text-2xl font-bold mb-3">Access denied</h1>
        <p className="text-sm text-muted-foreground">
          This area is restricted to administrators. If you believe this is a
          mistake, contact an administrator for your account.
        </p>
      </section>
    </main>
  );
}

/**
 * Server-side admin authorization boundary (#134).
 *
 * Every /admin route is rendered through this layout, which verifies the
 * signed session cookie, resolves the session subject to a database profile
 * and checks the admin role policy BEFORE children are rendered. Unauthorized
 * visitors are redirected home or shown an access-denied page, so protected
 * client pages never reach the browser without a server-verified identity.
 */
export default async function AdminLayout({ children }) {
  const request = { headers: await headers() };
  const decision = await verifyAdminRequest(request);

  if (!decision.authorized) {
    if (decision.reason === ADMIN_DENIAL_REASONS.NOT_ADMIN) {
      return <AccessDenied />;
    }
    redirect("/");
  }

  return <>{children}</>;
}