export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { validateMaterialPayload, validateMaterialUpdatePayload, validateChangeReason } from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { verifyDashboardToken } from "@/lib/auth/session";
import { buildMaterialHistoryEntry, EDITABLE_MATERIAL_FIELDS } from "@/lib/backend/schemaContracts";

export const runtime = "nodejs";

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET);
  if (!verification.valid) {
    return null;
  }
  return verification.payload;
}

/**
 * Removes sensitive fields from material documents before public/client exposure.
 */
function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  return safe;
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "materials", rateLimit: { limit: 40, windowMs: 60_000 } },
    async () => {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      auditLog({ event: "auth_failed", route: "materials", method: "POST", status: 401 });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const material = validateMaterialPayload(await request.json());

    const db = await getDb();

    // Resolve uploader wallet address reliably
    let userAddress = user.walletAddress || user.address || null;
    if (!userAddress && user.sub) {
      try {
        const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
        userAddress = dbUser?.walletAddress || dbUser?.walletAddressLower || null;
      } catch (e) {
        // best-effort; keep null if lookup fails
        console.warn("User lookup failed while creating material:", e?.message || e);
      }
    }

    const doc = {
      userAddress,
      ...material,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("materials").insertOne(doc);
    auditLog({ event: "material_created", route: "materials", method: "POST", status: 201, actor: user.sub });
    return NextResponse.json({ id: result.insertedId, ...sanitizeMaterial(doc) }, { status: 201 });
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "material_create_failed", route: "materials", method: "POST", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "materials", rateLimit: { limit: 80, windowMs: 60_000 } },
    async () => {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      auditLog({ event: "auth_failed", route: "materials", method: "GET", status: 401 });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = user.walletAddress || user.address || user.id;
    const items = await db
      .collection("materials")
      .find({ userAddress })
      .sort({ createdAt: -1 })
      .toArray();

    const normalized = items.map(sanitizeMaterial);
    return NextResponse.json(normalized);
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "material_list_failed", route: "materials", method: "GET", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

export async function PUT(request) {
  return withApiHardening(
    request,
    { route: "materials", rateLimit: { limit: 40, windowMs: 60_000 } },
    async () => {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      auditLog({ event: "auth_failed", route: "materials", method: "PUT", status: 401 });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const materialId = url.searchParams.get("id");
    if (!materialId || !ObjectId.isValid(materialId)) {
      return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
    }

    const body = await request.json();
    const updates = validateMaterialUpdatePayload(body);
    const changeReason = validateChangeReason(body.changeReason);

    const db = await getDb();
    const userAddress = user.walletAddress || user.address || user.id;

    const existing = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
    if (!existing) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    if (existing.userAddress !== userAddress) {
      auditLog({ event: "material_update_forbidden", route: "materials", method: "PUT", status: 403, actor: user.sub });
      return NextResponse.json({ error: "Forbidden: not the material owner" }, { status: 403 });
    }

    const now = new Date();
    const updateDoc = { ...updates, updatedAt: now, updatedBy: userAddress };

    const result = await db.collection("materials").findOneAndUpdate(
      { _id: new ObjectId(materialId) },
      { $set: updateDoc },
      { returnDocument: "after" }
    );

    const historyEntry = buildMaterialHistoryEntry({
      materialId,
      previousDoc: existing,
      update: updates,
      updatedBy: userAddress,
      changeReason,
      source: "creator",
    });

    await db.collection("material_history").insertOne(historyEntry);

    auditLog({ event: "material_updated", route: "materials", method: "PUT", status: 200, actor: user.sub, materialId });
    return NextResponse.json(sanitizeMaterial(result));
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "material_update_failed", route: "materials", method: "PUT", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

export async function PATCH(request) {
  return PUT(request);
}
