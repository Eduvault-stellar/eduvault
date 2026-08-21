export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { sanitizeString } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

function sanitizeSavedMaterial(doc) {
  if (!doc) return doc;
  const { _id, walletAddress, materialId, savedAt } = doc;
  return { id: _id, walletAddress, materialId, savedAt };
}

// GET /api/saved-materials - List saved materials for current user
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "saved-materials", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "saved-materials", method: "GET", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const walletAddress = (user.walletAddress || user.address || user.id || "").toLowerCase();
        if (!walletAddress) {
          return NextResponse.json({ error: "No wallet address found" }, { status: 400 });
        }

        const db = await getDb();

        const savedItems = await db
          .collection("saved_materials")
          .find({ walletAddress })
          .sort({ savedAt: -1 })
          .toArray();

        const materialIds = savedItems
          .map((s) => {
            try { return new ObjectId(s.materialId); } catch { return null; }
          })
          .filter(Boolean);

        const materials = materialIds.length > 0
          ? await db
              .collection("materials")
              .find({ _id: { $in: materialIds } })
              .toArray()
          : [];

        const materialMap = new Map();
        for (const m of materials) {
          materialMap.set(String(m._id), m);
        }

        const result = savedItems.map((saved) => {
          const material = materialMap.get(saved.materialId);
          if (material) {
            const { storageKey, fileUrl, metadataUrl, ...safe } = material;
            return {
              id: saved._id,
              savedAt: saved.savedAt,
              material: safe,
            };
          }
          return {
            id: saved._id,
            savedAt: saved.savedAt,
            materialId: saved.materialId,
          };
        });

        return NextResponse.json({ items: result });
      } catch (err) {
        if (err.name === "ValidationError") throw err;
        auditLog({ event: "saved_materials_list_failed", route: "saved-materials", method: "GET", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

// POST /api/saved-materials - Save a material (idempotent)
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "saved-materials", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "saved-materials", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const walletAddress = (user.walletAddress || user.address || user.id || "").toLowerCase();
        if (!walletAddress) {
          return NextResponse.json({ error: "No wallet address found" }, { status: 400 });
        }

        const body = await request.json();
        const materialId = sanitizeString(body?.materialId, { maxLength: 100 });

        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const db = await getDb();

        const material = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const doc = {
          walletAddress,
          materialId,
          savedAt: new Date(),
        };
        const savedMaterials = db.collection("saved_materials");
        let upsertResult;

        try {
          upsertResult = await savedMaterials.updateOne(
            { walletAddress, materialId },
            { $setOnInsert: doc },
            { upsert: true },
          );
        } catch (error) {
          // A unique index is the final concurrency boundary. If two requests
          // race during an upsert, the loser still observes an idempotent save.
          if (error?.code !== 11000 && error?.codeName !== "DuplicateKey") throw error;
        }

        const saved = await savedMaterials.findOne(
          { walletAddress, materialId },
          { projection: { _id: 1 } },
        );
        const created = upsertResult?.upsertedCount === 1;
        const status = created ? 201 : 200;

        auditLog({ event: "material_saved", route: "saved-materials", method: "POST", status, actor: user.sub, materialId, created });
        return NextResponse.json({ saved: true, id: saved?._id, materialId }, { status });
      } catch (err) {
        if (err.name === "ValidationError") throw err;
        auditLog({ event: "material_save_failed", route: "saved-materials", method: "POST", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

// DELETE /api/saved-materials?materialId=xxx - Unsave a material
export async function DELETE(request) {
  return withApiHardening(
    request,
    { route: "saved-materials", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "saved-materials", method: "DELETE", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const walletAddress = (user.walletAddress || user.address || user.id || "").toLowerCase();
        if (!walletAddress) {
          return NextResponse.json({ error: "No wallet address found" }, { status: 400 });
        }

        const url = new URL(request.url);
        const materialId = url.searchParams.get("materialId");

        if (!materialId) {
          return NextResponse.json({ error: "Missing materialId parameter" }, { status: 400 });
        }

        const db = await getDb();
        const result = await db.collection("saved_materials").deleteOne({
          walletAddress,
          materialId,
        });

        auditLog({ event: "material_unsaved", route: "saved-materials", method: "DELETE", status: 200, actor: user.sub, materialId });
        return NextResponse.json({ unsaved: true, deleted: result.deletedCount > 0 });
      } catch (err) {
        if (err.name === "ValidationError") throw err;
        auditLog({ event: "material_unsave_failed", route: "saved-materials", method: "DELETE", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
