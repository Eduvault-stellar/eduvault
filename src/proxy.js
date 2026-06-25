/**
 * Route protection proxy — Next.js 16+ convention.
 *
 * Replaces the deprecated `src/middleware.js` convention (issue #114).
 * Protects all /dashboard routes: unauthenticated requests are redirected
 * to the homepage.
 *
 * Next.js 16 changed the file convention from `middleware.js` (with a
 * `middleware` export) to `proxy.js` (with a `proxy` export). The route
 * matcher and the auth logic are otherwise identical.
 */
import { NextResponse } from "next/server";
import { isProtectedDashboardPath, verifyDashboardToken } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

export async function proxy(req) {
  const token = req.cookies.get("auth_token")?.value;
  const { pathname } = req.nextUrl;

  // Log all incoming requests handled by the proxy
  logger.info({
    method: req.method,
    url: req.url,
    pathname,
    timestamp: new Date().toISOString()
  }, 'Incoming request');

  if (!isProtectedDashboardPath(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.JWT_SECRET;
  if (!token || !secret) {
    const url = new URL("/", req.url);
    return NextResponse.redirect(url);
  }

  const verification = await verifyDashboardToken(token, secret);
  if (!verification.valid) {
    const url = new URL("/", req.url);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/:path*"],
};
