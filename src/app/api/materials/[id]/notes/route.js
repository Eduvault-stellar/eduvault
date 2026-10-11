export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { withAuthorization } from "@/lib/auth/authorize";
import { errorResponse } from "@/lib/api/errorResponse";

const NOTES_COLLECTION = "learner_notes";
const MAX_NOTE_LENGTH = 10000;

function makeFilter(materialId, walletAddress) {
  return { materialId, walletAddress: walletAddress.toLowerCase() };
}

// GET /api/materials/[id]/notes - fetch the current user's note with strict owner isolation
export const GET = withApiHardening(
  async (request, { params }) => {
    return withAuthorization(
      async (authorizedRequest) => {
        const materialId = params?.id;
        if (!materialId || !ObjectId.isValid(materialId)) {
          return errorResponse("Invalid material ID", 400);
        }

        const { userId, fullUser } = authorizedRequest;
        const walletAddress = (fullUser?.walletAddress || userId || "").toLowerCase();
        if (!walletAddress) {
          return errorResponse("No wallet address found", 400);
        }

        try {
          const db = await getDb();
          const doc = await db.collection(NOTES_COLLECTION).findOne(makeFilter(materialId, walletAddress));

          return NextResponse.json({
            note: doc?.note ?? "",
            version: doc?.version ?? 1,
            isEncrypted: doc?.isEncrypted ?? false,
            updatedAt: doc?.updatedAt ?? null,
          });
        } catch (err) {
          auditLog({ event: "notes_fetch_failed", route: "materials.notes", method: "GET", status: 500, reason: err.message });
          return errorResponse("Server error", 500);
        }
      },
      {}
    )(request);
  },
  { route: "materials.notes", rateLimit: { limit: 60, windowMs: 60_000 } }
);

// PUT /api/materials/[id]/notes - upsert note with optimistic concurrency control and encrypted payload support
export const PUT = withApiHardening(
  async (request, { params }) => {
    return withAuthorization(
      async (authorizedRequest) => {
        const materialId = params?.id;
        if (!materialId || !ObjectId.isValid(materialId)) {
          return errorResponse("Invalid material ID", 400);
        }

        const { userId, fullUser } = authorizedRequest;
        const walletAddress = (fullUser?.walletAddress || userId || "").toLowerCase();
        if (!walletAddress) {
          return errorResponse("No wallet address found", 400);
        }

        let body;
        try {
          body = await authorizedRequest.json();
        } catch {
          return errorResponse("Invalid JSON", 400);
        }

        const rawNote = typeof body?.note === "string" ? body.note.slice(0, MAX_NOTE_LENGTH) : "";
        const isEncrypted = Boolean(body?.isEncrypted);
        const expectedVersion = typeof body?.version === "number" ? body.version : null;

        try {
          const db = await getDb();
          const now = new Date();
          const filter = makeFilter(materialId, walletAddress);

          // Optimistic concurrency control check
          const existing = await db.collection(NOTES_COLLECTION).findOne(filter);
          if (existing && expectedVersion !== null && existing.version && existing.version > expectedVersion) {
            return errorResponse("Conflict: note has been modified concurrently", 409);
          }

          const nextVersion = (existing?.version || 0) + 1;

          await db.collection(NOTES_COLLECTION).updateOne(
            filter,
            {
              $set: {
                note: rawNote,
                isEncrypted,
                version: nextVersion,
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true }
          );

          auditLog({ event: "notes_saved", route: "materials.notes", method: "PUT", status: 200, actor: userId });
          return NextResponse.json({
            note: rawNote,
            version: nextVersion,
            isEncrypted,
            updatedAt: now.toISOString(),
          });
        } catch (err) {
          auditLog({ event: "notes_save_failed", route: "materials.notes", method: "PUT", status: 500, reason: err.message });
          return errorResponse("Server error", 500);
        }
      },
      {}
    )(request);
  },
  { route: "materials.notes", rateLimit: { limit: 30, windowMs: 60_000 } }
);

// DELETE /api/materials/[id]/notes - user-directed immediate note deletion
export const DELETE = withApiHardening(
  async (request, { params }) => {
    return withAuthorization(
      async (authorizedRequest) => {
        const materialId = params?.id;
        if (!materialId || !ObjectId.isValid(materialId)) {
          return errorResponse("Invalid material ID", 400);
        }

        const { userId, fullUser } = authorizedRequest;
        const walletAddress = (fullUser?.walletAddress || userId || "").toLowerCase();
        if (!walletAddress) {
          return errorResponse("No wallet address found", 400);
        }

        try {
          const db = await getDb();
          const filter = makeFilter(materialId, walletAddress);
          const result = await db.collection(NOTES_COLLECTION).deleteOne(filter);

          auditLog({ event: "notes_deleted", route: "materials.notes", method: "DELETE", status: 200, actor: userId });
          return NextResponse.json({ deletedCount: result.deletedCount });
        } catch (err) {
          auditLog({ event: "notes_delete_failed", route: "materials.notes", method: "DELETE", status: 500, reason: err.message });
          return errorResponse("Server error", 500);
        }
      },
      {}
    )(request);
  },
  { route: "materials.notes", rateLimit: { limit: 30, windowMs: 60_000 } }
);