import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { withAuthorization } from "@/lib/auth/authorize";
import { normalizeOrderedMaterialIds } from "@/lib/collections/integrity";

export const runtime = "nodejs";

function errorResponse(message, status) {
  return NextResponse.json({ error: message }, { status });
}

export const POST = withApiHardening(
  withAuthorization(
    async (authorizedRequest) => {
      try {
        const { userId } = authorizedRequest;
        const payload = await authorizedRequest.json();
        const db = await getDb();

        const materialIds = normalizeOrderedMaterialIds(payload.materialIds || []);
        if (materialIds.some((id) => !ObjectId.isValid(id))) {
          return errorResponse("materialIds contains an invalid material ID", 400);
        }

        const now = new Date();
        const doc = {
          title: String(payload.title || "").trim(),
          description: String(payload.description || "").trim(),
          creatorId: userId,
          materialIds,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };

        if (!doc.title) return errorResponse("Title is required", 400);

        const result = await db.collection("collections").insertOne(doc);
        return NextResponse.json({ id: result.insertedId, ...doc }, { status: 201 });
      } catch (err) {
        if (err instanceof TypeError || err instanceof RangeError) {
          return errorResponse(err.message, 400);
        }
        console.error("[api/collections] POST error:", err);
        return errorResponse("Server error", 500);
      }
    },
    {
      checkOwnership: async () => true, // Any authenticated user can create a collection
    }
  ),
  { route: "collections", rateLimit: { limit: 40, windowMs: 60_000 } }
);

export const GET = withApiHardening(
  withAuthorization(
    async (authorizedRequest) => {
      try {
        const { userId } = authorizedRequest;
        const db = await getDb();
        const items = await db
          .collection("collections")
          .find({ creatorId: userId }) // Filter by authenticated user's ID
          .sort({ createdAt: -1 })
          .toArray();

        return NextResponse.json(items);
      } catch (err) {
        console.error("[api/collections] GET error:", err);
        return errorResponse("Server error", 500);
      }
    },
    {
      checkOwnership: async () => true, // Any authenticated user can view their own collections
    }
  ),
  { route: "collections", rateLimit: { limit: 80, windowMs: 60_000 } }
);
