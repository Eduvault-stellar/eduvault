export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { withAuthorization } from "@/lib/auth/authorize";
import { getDb } from "@/lib/mongodb";
import {
  getMilestonesByEscrow,
  createMilestone,
} from "@/lib/backend/milestoneService";

export const GET = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { escrowId } = await params;
        if (!escrowId) {
          return NextResponse.json({ error: "Escrow ID is required" }, { status: 400 });
        }

        const db = await getDb();
        const milestones = await getMilestonesByEscrow(db, escrowId);

        return NextResponse.json(milestones);
      } catch (err) {
        console.error("[api/escrows/milestones] GET error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    { public: true },
  ),
  { route: "escrow_milestones", rateLimit: { limit: 120, windowMs: 60_000 } },
);

export const POST = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { escrowId } = await params;
        if (!escrowId) {
          return NextResponse.json({ error: "Escrow ID is required" }, { status: 400 });
        }

        const body = await authorizedRequest.json();
        const db = await getDb();

        const milestone = await createMilestone(db, {
          payoutId: body.payoutId || null,
          escrowId,
          order: body.order,
          title: body.title,
          description: body.description,
          amount: body.amount,
          currency: body.currency,
          dueDate: body.dueDate ? new Date(body.dueDate) : null,
          createdBy: authorizedRequest.userId || body.createdBy || null,
        });

        return NextResponse.json(milestone, { status: 201 });
      } catch (err) {
        if (err.message?.includes("exceeds payout amount")) {
          return NextResponse.json({ error: err.message }, { status: 422 });
        }
        console.error("[api/escrows/milestones] POST error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    {},
  ),
  { route: "escrow_milestones_create", rateLimit: { limit: 30, windowMs: 60_000 } },
);
