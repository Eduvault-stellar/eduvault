import { NextResponse } from 'next/server';
import { revokeRefreshTokenFamilyByToken, revokeRefreshTokensForUser } from '@/lib/auth/tokenService';
import { auditLog } from '@/lib/api/audit';
import { withApiHardening } from '@/lib/api/hardening';
import { getUserFromCookie } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/errorResponse';

function getRefreshTokenFromCookie(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/refresh_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "auth-logout", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        const refreshToken = getRefreshTokenFromCookie(request);

        const response = NextResponse.json({ success: true });

        response.cookies.set('auth_token', '', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: 0,
        });

        response.cookies.set('refresh_token', '', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/api/auth/refresh',
          maxAge: 0,
        });

        if (refreshToken) {
          await revokeRefreshTokenFamilyByToken(refreshToken, user?.sub);
        } else if (user?.sub) {
          await revokeRefreshTokensForUser(user.sub);
        }

        auditLog({
          event: "auth_logout_success",
          route: "auth/logout",
          method: "POST",
          status: 200,
          actor: user?.sub,
          address: user?.walletAddress,
        });

        return response;
      } catch (error) {
        console.error('POST /api/auth/logout error:', error);
        auditLog({
          event: "auth_logout_error",
          route: "auth/logout",
          method: "POST",
          status: 500,
          reason: error.message,
        });
        return errorResponse('Server error', 500);
      }
    }
  );
}
