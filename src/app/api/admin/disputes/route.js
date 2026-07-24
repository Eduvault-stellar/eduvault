export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { withAuthorization } from "@/lib/auth/authorize";
import { isAdmin } from "@/lib/auth/policies";

export const GET = withAuthorization(
  async (request) => {
    try {
      const db = await getDb();
      const disputes = await db
        .collection("disputes")
        .find({})
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      return NextResponse.json({ disputes });
    } catch (error) {
      console.error("[admin/disputes] GET error:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
  {
    checkOwnership: async (userId, fullUser) => {
      return isAdmin(fullUser);
    },
  }
);

export const PATCH = withAuthorization(
  async (request) => {
    try {
      const { userId } = request;
      const { disputeId, status, resolution } = await request.json();
      if (!disputeId || !status) {
        return NextResponse.json({ error: "disputeId and status are required" }, { status: 400 });
      }

      const db = await getDb();
      const result = await db.collection("disputes").updateOne(
        { _id: disputeId },
        {
          $set: {
            status,
            resolution: resolution ?? null,
            resolvedBy: userId,
            resolvedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
      }

      return NextResponse.json({ success: true });
    } catch (error) {
      console.error("[admin/disputes] PATCH error:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
  {
    checkOwnership: async (userId, fullUser) => {
      return isAdmin(fullUser);
    },
  }
);