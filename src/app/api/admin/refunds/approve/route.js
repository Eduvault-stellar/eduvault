import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { getUserFromCookie } from '@/lib/api/auth';
import { approveRefundOnChain } from '@/lib/stellar/refundService';
import { auditLog } from '@/lib/api/audit';
import { ObjectId } from 'mongodb';

export async function POST(request) {
  try {
    const user = await getUserFromCookie(request);
    
    // Verify admin permissions
    if (!user || user.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
    }

    const body = await request.json();
    const { refundId } = body;

    if (!refundId) {
      return NextResponse.json({ error: 'Missing refundId' }, { status: 400 });
    }

    const db = await getDb();
    const refundCollection = db.collection('refunds');
    
    const refundRecord = await refundCollection.findOne({ _id: new ObjectId(refundId) });

    if (!refundRecord) {
      return NextResponse.json({ error: 'Refund record not found' }, { status: 404 });
    }

    if (refundRecord.status === 'approved') {
      return NextResponse.json({ error: 'Refund is already approved' }, { status: 400 });
    }

    // Interact with the smart contract
    const onChainResult = await approveRefundOnChain(
      refundId,
      refundRecord.buyerAddress,
      refundRecord.amount,
      refundRecord.asset || 'USDC'
    );

    if (onChainResult.success) {
      // Update DB record
      await refundCollection.updateOne(
        { _id: new ObjectId(refundId) },
        { 
          $set: { 
            status: 'approved',
            transactionHash: onChainResult.hash,
            approvedAt: new Date(),
            approvedBy: user.walletAddress || user._id
          }
        }
      );

      auditLog({
        event: "admin_refund_approved",
        route: "admin/refunds/approve",
        method: "POST",
        status: 200,
        adminAddress: user.walletAddress,
        refundId
      });

      return NextResponse.json({ success: true, transactionHash: onChainResult.hash });
    } else {
      return NextResponse.json({ error: 'On-chain refund approval failed' }, { status: 500 });
    }

  } catch (error) {
    console.error('POST /api/admin/refunds/approve error:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
