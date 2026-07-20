export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import {
  FEEDBACK_COLLECTION,
  feedbackModerationPlaceholder,
  isCreatorFeedback,
  sanitizeFeedback,
  summarizeFeedback,
  validateFeedbackPayload,
} from "@/lib/backend/materialFeedback";

export const runtime = "nodejs";

function materialObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

async function findPublicMaterial(db, id) {
  const objectId = materialObjectId(id);
  if (!objectId) return null;
  return db.collection("materials").findOne({ _id: objectId, visibility: "public" });
}

function feedbackFilter(id) {
  const objectId = materialObjectId(id);
  return {
    $or: [
      { materialId: id },
      ...(objectId ? [{ materialObjectId: objectId }] : []),
    ],
    status: { $ne: "hidden" },
    moderationStatus: { $ne: "rejected" },
  };
}

async function getReviewerAddress(db, user) {
  let address = user?.walletAddress || user?.address || user?.walletAddressLower || user?.id || "";

  if (!address && user?.sub && ObjectId.isValid(user.sub)) {
    const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
    address = dbUser?.walletAddress || dbUser?.address || dbUser?.walletAddressLower || "";
  }

  return typeof address === "string" ? address.trim() : "";
}

async function updateMaterialFeedbackSummary(db, materialId) {
  const items = await db.collection(FEEDBACK_COLLECTION).find(feedbackFilter(materialId)).toArray();
  const summary = summarizeFeedback(items);
  const objectId = materialObjectId(materialId);

  if (objectId) {
    await db.collection("materials").updateOne(
      { _id: objectId },
      {
        $set: {
          averageScore: summary.averageScore,
          rating: summary.averageScore,
          feedbackCount: summary.feedbackCount,
          reviewsCount: summary.feedbackCount,
          updatedAt: new Date(),
        },
      }
    );
  }

  return { ...summary, items };
}

export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.feedback", rateLimit: { limit: 120, windowMs: 60_000 } },
    async () => {
      try {
        const materialId = params?.id;
        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const db = await getDb();
        const material = await findPublicMaterial(db, materialId);
        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const items = await db
          .collection(FEEDBACK_COLLECTION)
          .find(feedbackFilter(materialId))
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray();
        const summary = summarizeFeedback(items);

        return NextResponse.json({
          items: items.map(sanitizeFeedback),
          ...summary,
          moderation: feedbackModerationPlaceholder(),
        });
      } catch (err) {
        auditLog({ event: "material_feedback_list_failed", route: "materials.feedback", method: "GET", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function POST(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.feedback", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const materialId = params?.id;
        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "materials.feedback", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const payload = validateFeedbackPayload(await request.json());
        const db = await getDb();
        const material = await findPublicMaterial(db, materialId);
        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const reviewerAddress = await getReviewerAddress(db, user);
        if (!reviewerAddress) {
          return NextResponse.json({ error: "A wallet address is required to leave feedback." }, { status: 400 });
        }

        if (isCreatorFeedback(material, reviewerAddress)) {
          auditLog({ event: "creator_feedback_blocked", route: "materials.feedback", method: "POST", status: 403, actor: user.sub, materialId });
          return NextResponse.json({ error: "Creators cannot score their own resource." }, { status: 403 });
        }

        const now = new Date();
        const materialObjectIdValue = new ObjectId(materialId);
        const feedbackDoc = {
          materialId,
          materialObjectId: materialObjectIdValue,
          score: payload.score,
          rating: payload.score,
          comment: payload.comment,
          reviewerAddress,
          reviewerId: user.sub || user.id || null,
          reviewerName: user.name || "",
          verifiedBuyer: false,
          moderationStatus: "pending_review",
          status: "published",
          updatedAt: now,
        };

        const result = await db.collection(FEEDBACK_COLLECTION).findOneAndUpdate(
          { materialId, reviewerAddress },
          { $set: feedbackDoc, $setOnInsert: { createdAt: now } },
          { upsert: true, returnDocument: "after" }
        );

        const { items, averageScore, feedbackCount } = await updateMaterialFeedbackSummary(db, materialId);
        const savedFeedback = result || items.find((item) => item.reviewerAddress === reviewerAddress) || feedbackDoc;

        auditLog({ event: "material_feedback_saved", route: "materials.feedback", method: "POST", status: 200, actor: user.sub, materialId });
        return NextResponse.json({
          feedback: sanitizeFeedback(savedFeedback),
          averageScore,
          feedbackCount,
          moderation: feedbackModerationPlaceholder(),
        });
      } catch (err) {
        if (err.name === "ValidationError") {
          return NextResponse.json({ error: err.message, details: err.details }, { status: 400 });
        }

        auditLog({ event: "material_feedback_save_failed", route: "materials.feedback", method: "POST", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
