import { NextResponse } from "next/server";

import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getDb } from "@/lib/mongodb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function publicOperation(operation) {
  return {
    idempotencyKey: operation.idempotencyKey,
    operationType: operation.operationType,
    state: operation.state,
    stage: operation.stage || null,
    transactionHash: operation.transactionHash || null,
    ledgerSequence: operation.ledgerSequence ?? null,
    retryCount: operation.retryCount || 0,
    reconciliationFailureCount: operation.reconciliationFailureCount || 0,
    terminal: operation.terminal === true,
    nextAttemptAt: operation.nextAttemptAt || null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "escrow-operation-status", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { idempotencyKey } = await params;
      if (!idempotencyKey) {
        return NextResponse.json({ error: "Missing idempotency key" }, { status: 400 });
      }

      const db = await getDb();
      const operation = await db
        .collection(COLLECTIONS.escrowOperations)
        .findOne({ idempotencyKey: decodeURIComponent(idempotencyKey) });

      if (!operation) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      const userWallets = [
        user.walletAddress,
        user.walletAddressLower,
        user.payoutWalletAddress,
        user.payoutWalletAddressLower,
        user.address,
        user.id,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      const actor = operation.actor ? String(operation.actor).toLowerCase() : null;
      if (actor && !userWallets.includes(actor) && user.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      return NextResponse.json(publicOperation(operation));
    },
  );
}
