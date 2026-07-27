import { NextResponse } from 'next/server';
import { revokeRefreshTokenFamilyByToken, revokeRefreshTokensForUser } from '@/lib/auth/tokenService';
import { auditLog } from '@/lib/api/audit';
import { withApiHardening } from '@/lib/api/hardening';
import { withAuthorization } from '@/lib/auth/authorize';
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
    async () => logoutPost(request)
  );
}

async function logoutPost(request) {
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
export const POST = withAuthorization(
  async (authorizedRequest) => {
    try {
      const { userId, fullUser } = authorizedRequest;
      const refreshToken = getRefreshTokenFromCookie(authorizedRequest);

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
        await revokeRefreshTokenFamilyByToken(refreshToken, userId);
      } else if (userId) {
        await revokeRefreshTokensForUser(userId);
      }

      auditLog({
        event: "auth_logout_success",
        route: "auth/logout",
        method: "POST",
        status: 200,
        actor: userId,
        address: fullUser?.walletAddress,
      });

      return response;
    } catch (error) {
      console.error('POST /api/auth/logout error:', error);
      return errorResponse('Server error', 500);
    }
  },
  {}
);