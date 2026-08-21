import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { withAuthorization } from "@/lib/auth/authorize";
import {
  normalizeOrderedMaterialIds,
  requestedRevision,
  revisionFilter,
  revisionUpdatePipeline,
} from "@/lib/collections/integrity";

export const runtime = "nodejs";

function errorResponse(message, status, details = undefined) {
  return NextResponse.json({ error: message, ...details }, { status });
}

function collectionIdFrom(params) {
  try {
    return new ObjectId(params.id);
  } catch {
    return null;
  }
}

async function ownsCollection(userId, params) {
  const id = collectionIdFrom(params);
  if (!id) return false;
  const db = await getDb();
  return Boolean(await db.collection("collections").findOne({ _id: id, creatorId: userId }));
}

export const GET = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { userId } = authorizedRequest;
        const db = await getDb();
        const id = collectionIdFrom(params);
        if (!id) {
          return errorResponse("Invalid collection ID", 400);
        }

        const collection = await db.collection("collections").findOne({ _id: id, creatorId: userId });

        if (!collection) {
          return errorResponse("Collection not found", 404);
        }

        // Fetch materials in this collection
        let materials = [];
        if (collection.materialIds && collection.materialIds.length > 0) {
          const materialObjectIds = collection.materialIds.map(id => {
            try { return new ObjectId(id); } catch { return id; }
          });
          const unordered = await db.collection("materials").find({ _id: { $in: materialObjectIds } }).toArray();
          const byId = new Map(unordered.map((material) => [String(material._id), material]));
          materials = collection.materialIds.map((materialId) => byId.get(String(materialId))).filter(Boolean);
        }

        const revision = collection.revision || 1;
        const response = NextResponse.json({ ...collection, revision, materials });
        response.headers.set("ETag", `"${revision}"`);
        return response;
      } catch (err) {
        console.error("[api/collections/[id]] GET error:", err);
        return errorResponse("Server error", 500);
      }
    },
    {
      checkOwnership: async (userId, fullUser, request, { params }) => ownsCollection(userId, params),
    }
  ),
  { route: "collection_detail", rateLimit: { limit: 80, windowMs: 60_000 } }
);

export const PATCH = withApiHardening(
  withAuthorization(
    async (authorizedRequest, { params }) => {
      try {
        const { userId } = authorizedRequest;
        const id = collectionIdFrom(params);
        if (!id) return errorResponse("Invalid collection ID", 400);

        const payload = await authorizedRequest.json();
        const revision = requestedRevision(authorizedRequest, payload);
        if (!revision) {
          return errorResponse("A valid If-Match header or revision field is required", 428);
        }

        const updates = {};
        if (payload.title !== undefined) {
          updates.title = String(payload.title).trim();
          if (!updates.title) return errorResponse("Title is required", 400);
        }
        if (payload.description !== undefined) {
          updates.description = String(payload.description).trim();
        }
        if (payload.materialIds !== undefined) {
          updates.materialIds = normalizeOrderedMaterialIds(payload.materialIds);
          if (updates.materialIds.some((materialId) => !ObjectId.isValid(materialId))) {
            return errorResponse("materialIds contains an invalid material ID", 400);
          }
        }
        if (Object.keys(updates).length === 0) {
          return errorResponse("No editable fields supplied", 400);
        }

        const db = await getDb();
        const collections = db.collection("collections");
        const updated = await collections.findOneAndUpdate(
          revisionFilter({ id, creatorId: userId, revision }),
          revisionUpdatePipeline(updates),
          { returnDocument: "after" },
        );

        if (!updated) {
          const current = await collections.findOne(
            { _id: id, creatorId: userId },
            { projection: { revision: 1 } },
          );
          if (!current) return errorResponse("Collection not found", 404);
          return errorResponse("Collection was modified by another request", 409, {
            expectedRevision: revision,
            currentRevision: current.revision || 1,
          });
        }

        const response = NextResponse.json(updated);
        response.headers.set("ETag", `"${updated.revision}"`);
        return response;
      } catch (err) {
        if (err instanceof TypeError || err instanceof RangeError) {
          return errorResponse(err.message, 400);
        }
        console.error("[api/collections/[id]] PATCH error:", err);
        return errorResponse("Server error", 500);
      }
    },
    {
      checkOwnership: async (userId, fullUser, request, { params }) => ownsCollection(userId, params),
    },
  ),
  { route: "collection_update", rateLimit: { limit: 40, windowMs: 60_000 } },
);
