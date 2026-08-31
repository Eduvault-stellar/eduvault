export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getUserFromCookie } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import { validateRequestBody } from "@/lib/api/validateRequest";
import { publishRequestSchema } from "@/lib/materials/lifecycleSchemas";
import { getPublishingChecklist } from "@/lib/publishing/checklist";
import { getDb } from "@/lib/mongodb";
import {
  transitionMaterialStatus,
  MaterialLifecycleError,
  LIFECYCLE_ERROR_HTTP_STATUS,
  MATERIAL_STATUS,
} from "@/lib/materials/materialLifecycle";

/**
 * POST /api/materials/[id]/publish
 *
 * Transitions a draft (or already-published) material to published, via the
 * shared material lifecycle state machine — which already enforces the
 * publishing checklist, ownership, idempotency, and concurrency safety.
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

    const validation = await validateRequestBody(request, publishRequestSchema);
    if (!validation.ok) return validation.response;
    const { reason = null, contractId } = validation.data;

    const result = await transitionMaterialStatus({
      materialId,
      actor: user,
      toStatus: MATERIAL_STATUS.PUBLISHED,
      reason,
      extraFields: contractId ? { contractId } : {},
    });

    auditLog({
      event: result.alreadyInStatus ? "publish_already_published" : "publish_success",
      route: "material-publish",
      method: "POST",
      status: 200,
      actor: user.sub,
      materialId,
    });

    return NextResponse.json(
      { success: true, status: MATERIAL_STATUS.PUBLISHED, alreadyPublished: result.alreadyInStatus },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof MaterialLifecycleError) {
      const status = LIFECYCLE_ERROR_HTTP_STATUS[err.code] ?? 400;
      auditLog({
        event: "publish_failed",
        route: "material-publish",
        method: "POST",
        status,
        materialId: params?.id,
        reason: err.message,
      });
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error("Publish error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/**
 * GET /api/materials/[id]/publish
 *
 * Returns the publishing checklist for a material without publishing it, so
 * the UI can preview readiness (required/recommended fields, whether the
 * requester can publish) before submitting.
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

    const userAddress = user.walletAddress || user.address || user.sub;

    const db = await getDb();
    const material = await db.collection("materials").findOne({ _id: materialId });

    // Return the checklist even when the material isn't found, so the UI can
    // still show all fields as missing rather than erroring outright.
    const checklist = getPublishingChecklist(material);

    const owner = material?.userAddress || material?.ownerAddress;
    const isOwner = !!(material && owner && String(owner).toLowerCase() === String(userAddress).toLowerCase());

    return NextResponse.json({
      materialId,
      canPublish: isOwner && checklist.missingRequired.length === 0,
      isOwner,
      published: material?.status === MATERIAL_STATUS.PUBLISHED,
      checklist,
    });
  } catch (err) {
    console.error("Publish checklist error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
