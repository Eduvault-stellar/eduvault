export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { withAuthorization } from "@/lib/auth/authorize";
import { getDb } from "@/lib/mongodb";
import {
  addMilestoneEvidence,
  getMilestoneEvidence,
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
        const evidence = await getMilestoneEvidence(db, milestoneId);

        return NextResponse.json(evidence);
      } catch (err) {
        console.error("[api/milestones/evidence] GET error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    { public: true },
  ),
  { route: "milestone_evidence", rateLimit: { limit: 120, windowMs: 60_000 } },
);

export const POST = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { milestoneId } = await params;
        if (!milestoneId) {
          return NextResponse.json({ error: "Milestone ID is required" }, { status: 400 });
        }

        const body = await authorizedRequest.json();
        const db = await getDb();

        const evidence = await addMilestoneEvidence(db, milestoneId, {
          uploadedBy: authorizedRequest.userId || body.uploadedBy || "unknown",
          fileId: body.fileId || null,
          fileUrl: body.fileUrl || null,
          fileType: body.fileType || null,
          notes: body.notes || null,
        });

        return NextResponse.json(evidence, { status: 201 });
      } catch (err) {
        console.error("[api/milestones/evidence] POST error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    },
    {},
  ),
  { route: "milestone_evidence_create", rateLimit: { limit: 30, windowMs: 60_000 } },
);
