export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  encodeCursor,
  decodeCursor,
  validateSortField,
  clampResultWindow,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_RESULT_WINDOW,
  MAX_SEARCH_LENGTH,
} from "@/lib/backend/marketplaceDiscovery";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { cacheGet, cacheSet } from "@/lib/cache/redis";

export const runtime = "nodejs";

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  const averageScore = Number(safe.averageScore ?? safe.rating ?? 0) || 0;
  const feedbackCount = Number(safe.feedbackCount ?? safe.reviewsCount ?? 0) || 0;

  return {
    ...safe,
    averageScore,
    rating: averageScore,
    feedbackCount,
    reviewsCount: feedbackCount,
    userAddress: safe.userAddress ?? safe.ownerAddress ?? null,
  };
}

function buildCacheKey(searchParams, cursor) {
  const params = new URLSearchParams(searchParams);
  if (cursor) params.set("cursor", cursor);
  params.delete("page");
  return `market-materials:${params.toString()}`;
}

// GET /api/market-materials
// Deterministic cursor-based pagination with safe relevance indexing.
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "market-materials", rateLimit: { limit: 120, windowMs: 60_000 } },
    async () => {
  try {
    const db = await getDb();

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    // 1️⃣ Handle single material fetch
    if (id) {
      if (!ObjectId.isValid(id)) {
        return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
      }

      const item = await db.collection("materials").findOne({
        _id: new ObjectId(id),
        visibility: "public",
        status: "published",
      });

      if (!item) {
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      return NextResponse.json(sanitizeMaterial(item));
    }

    // 2️⃣ Handle cursor-based list fetch
    const cursor = url.searchParams.get("cursor") || null;
    const sortBy = validateSortField(url.searchParams.get("sortBy"));
    const pageSize = Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, Number(url.searchParams.get("pageSize") || "12")));

    const cacheKey = buildCacheKey(url.searchParams, cursor);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached, { status: 200 });
    }

    const query = buildMarketplaceDiscoveryQuery(url.searchParams);
    const sort = buildMarketplaceSort(sortBy);

    let filterQuery = { ...query };
    let cursorFilter = {};

    if (cursor) {
      const decoded = decodeCursor(cursor);
      cursorFilter = {
        $or: [
          { createdAt: { $lt: decoded.createdAt } },
          { createdAt: decoded.createdAt, _id: { $lt: new ObjectId(decoded.id) } },
        ],
      };
      filterQuery = { ...filterQuery, ...cursorFilter };
    }

    const total = await db.collection("materials").countDocuments(filterQuery);

    const items = await db
      .collection("materials")
      .find(filterQuery)
      .sort(sort)
      .limit(pageSize + 1)
      .toArray();

    const hasMore = items.length > pageSize;
    const pageItems = hasMore ? items.slice(0, pageSize) : items;

    const normalized = pageItems.map(sanitizeMaterial);

    let nextCursor = null;
    if (hasMore && pageItems.length > 0) {
      const lastItem = pageItems[pageItems.length - 1];
      nextCursor = encodeCursor(lastItem.createdAt, lastItem._id);
    }

    if (!cursor) {
      clampResultWindow(1, pageSize);
    }

    const payload = {
      items: normalized,
      nextCursor,
      hasMore,
      total,
      pageSize,
      sortBy,
      snapshotAt: new Date().toISOString(),
    };

    await cacheSet(cacheKey, payload, 300);

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "market_materials_failed", route: "market-materials", method: "GET", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}