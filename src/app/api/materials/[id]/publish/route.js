export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import { getPublishingChecklist } from "@/lib/publishing/checklist";
import {
  transitionMaterialStatus,
  MaterialLifecycleError,
  LIFECYCLE_ERROR_HTTP_STATUS,
  MATERIAL_STATUS,
} from "@/lib/materials/materialLifecycle";

/**
 * POST /api/materials/[id]/publish
 *
 * Transitions a material draft -> published via the material lifecycle
 * state machine, after verifying:
 *   1. The requester is authenticated.
 *   2. The requester owns the material.
 *   3. The material has all required fields populated (publishing checklist).
 */
export async function POST(request, { params }) {
  try {
    const materialId = params?.id;
    if (!materialId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    const user = await getUserFromCookie(request);
    if (!user) {
      auditLog({ event: "publish_auth_failed", route: "material-publish", method: "POST", status: 401, materialId });
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const userAddress = user.walletAddress || user.address || user.id;
    if (!userAddress) {
      auditLog({ event: "publish_no_address", route: "material-publish", method: "POST", status: 400, actor: user.sub, materialId });
      return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const contractId = typeof body.contractId === "string" ? body.contractId.trim() : undefined;

    let result;
    try {
      result = await transitionMaterialStatus({
        materialId,
        actor: user,
        toStatus: MATERIAL_STATUS.PUBLISHED,
        extraFields: {
          publishedAt: new Date(),
          ...(contractId ? { contractId } : {}),
        },
      });
    } catch (err) {
      if (err instanceof MaterialLifecycleError) {
        const status = LIFECYCLE_ERROR_HTTP_STATUS[err.code] ?? 400;
        auditLog({
          event: "publish_failed",
          route: "material-publish",
          method: "POST",
          status,
          actor: user.sub,
          materialId,
          reason: err.message,
        });
        return NextResponse.json(
          { error: err.message, code: err.code, checklist: getPublishingChecklist(await lookupMaterial(materialId)) },
          { status }
        );
      }
      throw err;
    }

    const checklist = getPublishingChecklist(result.material);

    auditLog({
      event: result.alreadyInStatus ? "publish_already_published" : "publish_success",
      route: "material-publish",
      method: "POST",
      status: 200,
      actor: user.sub,
      materialId,
    });

    return NextResponse.json(
      {
        success: true,
        status: MATERIAL_STATUS.PUBLISHED,
        alreadyPublished: result.alreadyInStatus,
        checklist,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Publish error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

async function lookupMaterial(materialId) {
  const db = await getDb();
  return db.collection("materials").findOne({ _id: materialId });
}

/**
 * GET /api/materials/[id]/publish
 *
 * Returns the publishing checklist for a material without publishing it.
 * Useful for the UI to show required/recommended fields before submission.
 */
export async function GET(request, { params }) {
  try {
    const materialId = params?.id;
    if (!materialId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const userAddress = user.walletAddress || user.address || user.id;
    if (!userAddress) {
      return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
    }

    const material = await lookupMaterial(materialId);

    // Return checklist even if material not found (shows all fields as missing)
    const checklist = getPublishingChecklist(material);

    // Ownership check for determining if user can publish
    const owner = material?.userAddress || material?.ownerAddress;
    const isOwner = material && owner && String(owner).toLowerCase() === String(userAddress).toLowerCase();

    return NextResponse.json({
      materialId,
      canPublish: isOwner && checklist.missingRequired.length === 0,
      isOwner,
      published: material?.status === MATERIAL_STATUS.PUBLISHED || false,
      checklist,
    });
  } catch (err) {
    console.error("Publish checklist error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
