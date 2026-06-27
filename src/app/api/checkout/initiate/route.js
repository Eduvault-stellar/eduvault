export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { getUserFromCookie } from "@/lib/api/auth";
import { applyTaxToCheckout } from '@/lib/checkout/taxEstimator';
import { getDb } from '@/lib/mongodb';
import { checkBuyerTrustline } from '@/lib/stellar/horizonClient';

/**
 * POST /api/checkout/initiate
 * Initiates a checkout with tax estimation based on buyer's geolocation
 */
export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { materialId, amount, asset, buyerIp, buyerCountry } = body;

    // Validate required fields
    if (!materialId) {
      return NextResponse.json({ error: 'Missing materialId' }, { status: 400 });
    }

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    if (!asset) {
      return NextResponse.json({ error: 'Missing asset' }, { status: 400 });
    }

    const buyerAddress = user.walletAddress || user.address || user.id;

    // Verify buyer holds an active trustline for the payment asset
    const assetCode = typeof asset === 'string' ? asset : asset.code || asset;
    const issuerAddress = typeof asset === 'object' ? asset.issuer : undefined;
    const trustlineCheck = await checkBuyerTrustline(buyerAddress, assetCode, issuerAddress);

    if (!trustlineCheck.hasTrustline) {
      return NextResponse.json({
        error: 'missing_trustline',
        message: trustlineCheck.instructions.message,
        instructions: trustlineCheck.instructions,
      }, { status: 400 });
    }

    // Get buyer IP from request if not provided
    const ipAddress = buyerIp || req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || null;

    // Apply tax estimation
    const checkoutWithTax = await applyTaxToCheckout({
      materialId,
      amount,
      asset,
      buyerIp: ipAddress,
      buyerCountry,
      buyerAddress,
    });

    // Store checkout intent in database for later processing
    const db = await getDb();
    const checkoutIntent = {
      materialId,
      buyerAddress,
      originalAmount: amount,
      taxAmount: checkoutWithTax.taxAmount,
      taxRateBps: checkoutWithTax.taxRateBps,
      totalAmount: checkoutWithTax.totalAmount,
      asset,
      geolocation: checkoutWithTax.geolocation,
      status: 'initiated',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
    };

    const result = await db.collection('checkout_intents').insertOne(checkoutIntent);

    return NextResponse.json({
      success: true,
      checkoutId: result.insertedId,
      checkout: {
        ...checkoutWithTax,
        checkoutId: result.insertedId,
        expiresAt: checkoutIntent.expiresAt,
      },
    }, { status: 201 });
  } catch (err) {
    console.error('POST /api/checkout/initiate error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/**
 * GET /api/checkout/initiate
 * Get tax estimation without creating a checkout intent
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const amount = parseFloat(searchParams.get('amount'));
    const asset = searchParams.get('asset');
    const buyerIp = searchParams.get('buyerIp');
    const buyerCountry = searchParams.get('buyerCountry');

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    const checkoutWithTax = await applyTaxToCheckout({
      amount,
      asset,
      buyerIp,
      buyerCountry,
    });

    return NextResponse.json({
      success: true,
      estimation: checkoutWithTax,
    });
  } catch (err) {
    console.error('GET /api/checkout/initiate error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
