import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { approveRefundOnChain } from '@/lib/stellar/refundService';
import { auditLog } from '@/lib/api/audit';
import { ObjectId } from 'mongodb';
import { withAuthorization } from "@/lib/auth/authorize";
import { isAdmin } from "@/lib/auth/policies";

export const POST = withAuthorization(
  async (request) => {
    try {
      const { userId, fullUser } = request;
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
              approvedBy: fullUser.walletAddress || userId
            }
          }
        );

        auditLog({
          event: "admin_refund_approved",
          route: "admin/refunds/approve",
          method: "POST",
          status: 200,
          adminAddress: fullUser.walletAddress,
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
  },
  {
    checkOwnership: async (userId, fullUser) => {
      return isAdmin(fullUser);
    },
  }
);