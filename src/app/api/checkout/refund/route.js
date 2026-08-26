import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import logger from '@/lib/logger';
import { auditLog } from '@/lib/api/audit';
import { withAuthorization } from "@/lib/auth/authorize";
import { isAdmin } from "@/lib/auth/policies";
import { getDb } from "@/lib/mongodb";
import { errorResponse } from "@/lib/api/errorResponse";
import { requestRefund } from "@/lib/stellar/refundService";

const REFUND_ERROR_STATUS = {
  purchase_not_found: 404,
  refund_window_expired: 400,
  duplicate_active_claim: 409,
  already_refunded: 409,
  purchase_not_refundable: 409,
  nothing_refundable: 422,
  daily_cap_exceeded: 429,
};

/**
 * Buyer/admin entry point for refunds (#27).
 *
 * Creates a policy-checked refund claim bound to a settled purchase receipt.
 * No funds move here and no caller-supplied amount/destination is trusted:
 * payable amount, asset, destination, and network are derived server-side by
 * the refund workflow.
 */
export const POST = withAuthorization(
  async (authorizedRequest) => {
    const { userId, fullUser } = authorizedRequest;
    try {
      const body = await authorizedRequest.json();
      const { transactionId, amount, reason } = body;

      if (!transactionId) {
        auditLog({
          event: 'refund_request_failed',
          route: 'checkout/refund',
          method: 'POST',
          status: 400,
          reason: 'Missing transactionId',
          actor: userId,
        });
        return errorResponse("Missing transactionId", 400);
      }

      const actor = fullUser?.walletAddress || userId;
      const result = await requestRefund({
        transactionId,
        requestedAmount: amount ?? null,
        actor,
        reason: typeof reason === "string" ? reason.slice(0, 500) : undefined,
      });

      if (!result.ok) {
        auditLog({
          event: 'refund_request_failed',
          route: 'checkout/refund',
          method: 'POST',
          status: result.httpStatus || 400,
          reason: result.code,
          actor,
        });
        return NextResponse.json(
          { error: result.message, code: result.code, refundId: result.refundId },
          { status: result.httpStatus || 400 }
        );
      }

      auditLog({
        event: 'refund_claim_created',
        route: 'checkout/refund',
        method: 'POST',
        status: 201,
        actor,
        refundId: String(result.refund._id),
      });

      return NextResponse.json(
        {
          message: 'Refund claim created and pending approval',
          refundId: String(result.refund._id),
          status: result.refund.status,
          amountUnits: result.refund.amountUnits,
          claimedUnits: result.refund.claimedUnits,
          feeRetainedUnits: result.refund.feeRetainedUnits,
          asset: result.refund.asset,
        },
        { status: 201 }
      );
    } catch (error) {
      logger.error({ err: error.message }, 'Failed to process refund request');
      auditLog({
        event: 'refund_request_error',
        route: 'checkout/refund',
        method: 'POST',
        status: 500,
        reason: error.message,
        actor: userId,
      });
      return errorResponse("Internal server error", 500);
    }
  },
  {
    checkOwnership: async (userId, fullUser, request) => {
      if (isAdmin(fullUser)) {
        return true; // Admins can initiate any refund
      }

      const body = await request.json();
      const transactionId = typeof body?.transactionId === "string" ? body.transactionId.trim() : "";

      if (!transactionId) {
        return false; // Cannot determine ownership without transactionId
      }

      const db = await getDb();
      const purchases = db.collection("purchases");
      let purchase = await purchases.findOne({ transactionHash: transactionId });
      if (!purchase && /^[a-f\d]{24}$/i.test(transactionId)) {
        const { ObjectId } = await import("mongodb");
        purchase = await purchases.findOne({ _id: new ObjectId(transactionId) });
      }

      if (!purchase) return false;
      const buyerAddress = String(purchase.buyerAddress || "").toLowerCase();
      const sessionAddress = String(fullUser?.walletAddress || userId || "").toLowerCase();
      return buyerAddress === sessionAddress; // Only the buyer of the transaction can initiate a refund
    },
  }
);
