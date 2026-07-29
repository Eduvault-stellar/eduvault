export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { withAuthorization } from "@/lib/auth/authorize";
import { getDb } from "@/lib/mongodb";
import { transitionMilestoneStatus } from "@/lib/backend/milestoneService";

export const POST = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { milestoneId } = await params;
        if (!milestoneId) {
          return NextResponse.json({ error: "Milestone ID is required" }, { status: 400 });
        }

        const body = await authorizedRequest.json().catch(() => ({}));
        const db = await getDb();

        const result = await transitionMilestoneStatus(db, milestoneId, "rejected", {
          changedBy: authorizedRequest.userId || body.changedBy || "unknown",
          reason: body.reason || null,
        });

        return NextResponse.json(result);
      } catch (err) {
        if (err.message?.includes("not found")) {
          return NextResponse.json({ error: err.message }, { status: 404 });
        }
        console.error("[api/milestones/reject] POST error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    {},
  ),
  { route: "milestone_reject", rateLimit: { limit: 30, windowMs: 60_000 } },
);
