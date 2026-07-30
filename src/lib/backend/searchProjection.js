import { getDb } from "../../lib/mongodb.js";
import { COLLECTIONS } from "./schemaContracts.js";
import { MATERIAL_STATUS } from "../materials/materialLifecycleConstants.js";
import { computeRelevanceScore } from "./marketplaceDiscovery.js";

export const SEARCH_PROJECTION_VERSION = 1;

export async function upsertSearchProjection(material) {
  const db = await getDb();
  const col = db.collection(COLLECTIONS.materials);

  const projection = {
    materialId: material._id || material.id,
    version: SEARCH_PROJECTION_VERSION,
    updatedAt: new Date(),
    fields: {
      title: material.title || "",
      description: material.description || "",
      shortSummary: material.shortSummary || "",
      author: material.author || material.userAddress || material.ownerAddress || "",
      subject: material.subject || "",
      category: material.category || "",
      level: material.level || "",
      tags: material.tags || [],
      price: Number(material.price ?? 0),
      rating: Number(material.averageScore ?? material.rating ?? 0),
      likes: Number(material.likes ?? 0),
      feedbackCount: Number(material.feedbackCount ?? material.reviewsCount ?? 0),
      visibility: material.visibility || "private",
      status: material.status || MATERIAL_STATUS.DRAFT,
      createdAt: material.createdAt || new Date(),
    },
  };

  const relevanceScore = computeRelevanceScore(projection.fields, "");
  projection.fields.relevanceScore = relevanceScore;

  await col.updateOne(
    { _id: projection.materialId },
    {
      $set: {
        relevanceScore: projection.fields.relevanceScore,
        relevanceStatus: projection.fields.visibility === "public" && projection.fields.status === MATERIAL_STATUS.PUBLISHED
          ? "active"
          : "low",
        searchProjectionVersion: SEARCH_PROJECTION_VERSION,
        searchProjectionUpdatedAt: projection.updatedAt,
      },
    },
    { upsert: true }
  );

  return projection;
}

export async function replaySearchProjection(materialId) {
  const db = await getDb();
  const col = db.collection(COLLECTIONS.materials);

  const material = await col.findOne({ _id: materialId });
  if (!material) {
    return { replayed: false, reason: "not_found" };
  }

  await upsertSearchProjection(material);
  return { replayed: true, materialId };
}

export async function replayAllSearchProjections({ batchSize = 100 } = {}) {
  const db = await getDb();
  const col = db.collection(COLLECTIONS.materials);

  const publicPublished = {
    visibility: "public",
    status: MATERIAL_STATUS.PUBLISHED,
  };

  const cursor = col.find(publicPublished).batchSize(batchSize);
  let replayed = 0;
  let skipped = 0;

  for await (const material of cursor) {
    try {
      await upsertSearchProjection(material);
      replayed += 1;
    } catch (err) {
      skipped += 1;
    }
  }

  return { replayed, skipped };
}

export async function reconcileSearchProjections() {
  const db = await getDb();
  const col = db.collection(COLLECTIONS.materials);

  const publicPublished = {
    visibility: "public",
    status: MATERIAL_STATUS.PUBLISHED,
  };

  const materials = await col.find(publicPublished).toArray();
  let reconciled = 0;
  let failed = 0;

  for (const material of materials) {
    try {
      const existing = await col.findOne({
        _id: material._id,
        searchProjectionVersion: SEARCH_PROJECTION_VERSION,
      });

      if (!existing || existing.searchProjectionUpdatedAt < material.updatedAt) {
        await upsertSearchProjection(material);
        reconciled += 1;
      }
    } catch (err) {
      failed += 1;
    }
  }

  return { reconciled, failed, total: materials.length };
}

export async function getSearchProjectionStats() {
  const db = await getDb();
  const col = db.collection(COLLECTIONS.materials);

  const total = await col.countDocuments({});
  const active = await col.countDocuments({
    visibility: "public",
    status: MATERIAL_STATUS.PUBLISHED,
    relevanceStatus: "active",
  });
  const low = await col.countDocuments({ relevanceStatus: "low" });
  const missing = await col.countDocuments({
    relevanceStatus: { $exists: false },
  });
  const withProjection = await col.countDocuments({
    searchProjectionVersion: SEARCH_PROJECTION_VERSION,
  });

  return {
    total,
    active,
    low,
    missing,
    withProjection,
    withoutProjection: total - withProjection,
    version: SEARCH_PROJECTION_VERSION,
  };
}