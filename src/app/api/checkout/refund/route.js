import { NextResponse } from 'next/server';
import { verifyRefundLimit } from '@/lib/checkout/refundVerifier';
import logger from '@/lib/logger';
import { auditLog } from '@/lib/api/audit';

export async function POST(req) {
  try {
    const body = await req.json();
    const { transactionId, refundAmount } = body;

    if (!transactionId || !refundAmount) {
      return NextResponse.json({ error: 'Missing transactionId or refundAmount' }, { status: 400 });
    }

    const verification = await verifyRefundLimit(transactionId, refundAmount);

    if (!verification.valid) {
      return NextResponse.json({ error: verification.reason }, { status: 400 });
    }

    // If valid, proceed with refund processing logic (e.g., interacting with Stellar network)
    // For this issue, we just need to validate and reject if invalid.
    auditLog({ event: 'refund_approved', transactionId, refundAmount, status: 'approved' });
    
    return NextResponse.json({ message: 'Refund validated successfully', data: verification.purchase });

  } catch (error) {
    logger.error({ err: error.message }, 'Failed to process refund request');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
