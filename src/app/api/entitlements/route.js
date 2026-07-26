export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server'
import { withApiHardening } from '@/lib/api/hardening';
import { errorResponse } from '@/lib/api/errorResponse';
import { verifyEntitlement } from '@/lib/entitlement'

export const GET = withApiHardening(
  async (req) => {
  try {
    const { searchParams } = new URL(req.url)
    const buyerAddress = searchParams.get('buyerAddress')
    const materialId = searchParams.get('materialId')

    if (!buyerAddress || !materialId) {
      return errorResponse('Missing buyerAddress or materialId', 400);
    }

    const { hasAccess, source } = await verifyEntitlement(materialId, buyerAddress)

    return NextResponse.json(
      { hasAccess, source },
      { status: 200 }
    )
  } catch (error) {
    console.error('Entitlement Check Error:', error)
    return errorResponse('Internal Server Error', 500);
  }
  },
  {
    route: 'entitlements',
    rateLimit: { limit: 100, windowMs: 60_000 }, // 100 requests/min per IP
  }
);