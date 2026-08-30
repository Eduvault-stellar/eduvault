import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import {
  approveRefund,
  settleRefund,
  getRefund,
} from '@/lib/stellar/refundService';
import { auditLog } from '@/lib/api/audit';
import { withAuthorization } from "@/lib/auth/authorize";
import { isAdmin } from "@/lib/auth/policies";
import { errorResponse } from "@/lib/api/errorResponse";

/**
 * Admin refund approval (#27).
 *
 * Approves a policy-checked refund claim through the compare-and-set state
 * machine and then settles it: signing happens via the dedicated constrained
 * refund signer, completion requires Horizon verification of the finalized
 * payment, and entitlement revocation converges only after settlement.
 */
export const POST = withAuthorization(
  async (request) => {
    const { userId, fullUser } = request;
    try {
      const body = await request.json();
      const { refundId, reason } = body;

      if (!refundId) {
        return errorResponse('Missing refundId', 400);
      }

      const actor = fullUser?.walletAddress || userId;

      const approval = await approveRefund({ refundId, actor, reason });
      if (!approval.ok) {
        auditLog({
          event: 'admin_refund_approval_failed',
          route: 'admin/refunds/approve',
          method: 'POST',
          status: approval.httpStatus || 400,
          reason: approval.code,
          actor,
          refundId,
        });
        return NextResponse.json(
          { error: approval.message, code: approval.code },
          { status: approval.httpStatus || 400 }
        );
      }

      if (approval.alreadyApproved) {
        // Idempotent retry: resume/inspect settlement instead of paying twice.
        const existing = await getRefund(refundId);
        if (existing?.status === 'settled') {
          return NextResponse.json({
            success: true,
            status: 'settled',
            transactionHash: existing.txHash,
          });
        }
        return NextResponse.json({
          success: true,
          status: existing?.status || 'approved',
          message: 'Refund already approved; settlement is in progress.',
        }, { status: 202 });
      }

      auditLog({
        event: 'admin_refund_approved',
        route: 'admin/refunds/approve',
        method: 'POST',
        status: 200,
        actor,
        refundId,
      });

      const settlement = await settleRefund(refundId);

      if (settlement.ok && settlement.settled) {
        return NextResponse.json({
          success: true,
          status: 'settled',
          transactionHash: settlement.refund.txHash,
          ledger: settlement.refund.ledger ?? null,
        });
      }

      if (settlement.ok && settlement.pendingVerification) {
        return NextResponse.json({
          success: true,
          status: 'pending',
          transactionHash: settlement.refund.txHash,
          message: 'Payment accepted; awaiting on-chain confirmation.',
        }, { status: 202 });
      }

      if (settlement.retryable) {
        return NextResponse.json({
          success: false,
          status: settlement.refund?.status || 'approved',
          code: settlement.code,
          message: 'Settlement will be retried automatically by the background worker.',
        }, { status: 503 });
      }

      return errorResponse(
        `On-chain refund settlement failed (${settlement.refund?.failedReason || settlement.code}).`,
        502
      );
    } catch (error) {
      console.error('POST /api/admin/refunds/approve error:', error);
      return errorResponse(error.message || 'Server error', 500);
    }
  },
  {
    checkOwnership: async (userId, fullUser) => {
      return isAdmin(fullUser);
    },
  }
);

/**
 * Read-only refund lookup so admins can inspect claim state without
 * triggering privileged transitions.
 */
export const GET = withAuthorization(
  async (request) => {
    try {
      const { searchParams } = new URL(request.url);
      const refundId = searchParams.get('refundId');
      if (!refundId) {
        return errorResponse('Missing refundId', 400);
      }

      const db = await getDb();
      let refund;
      try {
        const { ObjectId } = await import('mongodb');
        refund = await db.collection('refunds').findOne({ _id: new ObjectId(refundId) });
      } catch {
        refund = null;
      }
      if (!refund) {
        return errorResponse('Refund record not found', 404);
      }

      return NextResponse.json({
        refundId: String(refund._id),
        purchaseId: refund.purchaseId,
        materialId: refund.materialId,
        buyerAddress: refund.buyerAddress,
        asset: refund.asset,
        amountUnits: refund.amountUnits,
        feeRetainedUnits: refund.feeRetainedUnits,
        status: refund.status,
        txHash: refund.txHash,
        ledger: refund.ledger,
        operationIndex: refund.operationIndex,
        policyVersion: refund.policyVersion,
        attempts: refund.attempts,
        entitlementRevokedAt: refund.entitlementRevokedAt,
        createdAt: refund.createdAt,
        updatedAt: refund.updatedAt,
        auditTrail: (refund.auditTrail || []).map(({ hash, prevHash, ...rest }) => ({
          ...rest,
          hash,
          prevHash,
        })),
      });
    } catch (error) {
      console.error('GET /api/admin/refunds/approve error:', error);
      return errorResponse(error.message || 'Server error', 500);
    }
  },
  {
    checkOwnership: async (userId, fullUser) => {
      return isAdmin(fullUser);
    },
  }
);
