import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { withAuthorization } from "@/lib/auth/authorize";

export const runtime = "nodejs";

export const GET = withApiHardening(
  async (request, { params }) => {
    return withAuthorization(
      async (authorizedRequest) => {
        try {
          const { userId } = authorizedRequest;
          const db = await getDb();
          const collectionId = params.id;

          let query = {};
          try {
            query._id = new ObjectId(collectionId);
          } catch (e) {
            return NextResponse.json({ error: "Invalid collection ID" }, { status: 400 });
          }

          const collection = await db.collection("collections").findOne(query);

          if (!collection) {
            return NextResponse.json({ error: "Collection not found" }, { status: 404 });
          }

          // Fetch materials in this collection
          let materials = [];
          if (collection.materialIds && collection.materialIds.length > 0) {
            const materialObjectIds = collection.materialIds.map(id => {
              try { return new ObjectId(id); } catch { return id; }
            });
            materials = await db.collection("materials").find({ _id: { $in: materialObjectIds } }).toArray();
          }

          return NextResponse.json({ ...collection, materials });
        } catch (err) {
          console.error("[api/collections/[id]] GET error:", err);
          return NextResponse.json({ error: "Server error" }, { status: 500 });
        }
      },
      {
        checkOwnership: async (userId, fullUser, request) => {
          const db = await getDb();
          const collectionId = params.id;
          let query = {};
          try {
            query._id = new ObjectId(collectionId);
          } catch (e) {
            return false; // Invalid ID, deny access
          }
          const collection = await db.collection("collections").findOne(query);
          return collection && collection.creatorId === userId;
        },
      }
    )(request, { params }); // Pass the original request and params to withAuthorization
  },
  { route: "collection_detail", rateLimit: { limit: 80, windowMs: 60_000 } }
);