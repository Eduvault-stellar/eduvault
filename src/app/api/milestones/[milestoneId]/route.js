export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { withAuthorization } from "@/lib/auth/authorize";
import { getDb } from "@/lib/mongodb";
import {
  getMilestoneById,
  updateMilestone,
  deleteMilestone,
} from "@/lib/backend/milestoneService";

export const GET = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { milestoneId } = await params;
        if (!milestoneId) {
          return NextResponse.json({ error: "Milestone ID is required" }, { status: 400 });
        }

        const db = await getDb();
        const milestone = await getMilestoneById(db, milestoneId);
        if (!milestone) {
          return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
        }
        return NextResponse.json(milestone);
      } catch (err) {
        console.error("[api/milestones] GET error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    { public: true },
  ),
  { route: "milestone_detail", rateLimit: { limit: 120, windowMs: 60_000 } },
);

export const PUT = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { milestoneId } = await params;
        if (!milestoneId) {
          return NextResponse.json({ error: "Milestone ID is required" }, { status: 400 });
        }

        const body = await authorizedRequest.json();
        const db = await getDb();

        const expectedVersion = body.version;
        const updateFields = { ...body };
        delete updateFields.version;

        const updated = await updateMilestone(db, milestoneId, updateFields, expectedVersion);
        return NextResponse.json(updated);
      } catch (err) {
        if (err.message?.includes("version conflict")) {
          return NextResponse.json({ error: err.message }, { status: 409 });
        }
        if (err.message?.includes("not found")) {
          return NextResponse.json({ error: err.message }, { status: 404 });
        }
        console.error("[api/milestones] PUT error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    {},
  ),
  { route: "milestone_update", rateLimit: { limit: 60, windowMs: 60_000 } },
);

export const DELETE = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { milestoneId } = await params;
        if (!milestoneId) {
          return NextResponse.json({ error: "Milestone ID is required" }, { status: 400 });
        }

        const db = await getDb();
        const deleted = await deleteMilestone(db, milestoneId);
        if (!deleted) {
          return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
        }
        return NextResponse.json({ deleted: true });
      } catch (err) {
        console.error("[api/milestones] DELETE error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    {},
  ),
  { route: "milestone_delete", rateLimit: { limit: 30, windowMs: 60_000 } },
);
