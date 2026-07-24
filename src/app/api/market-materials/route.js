export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { parsePagination } from "@/lib/api/validation";
import { buildMarketplaceDiscoveryQuery, buildMarketplaceSort } from "@/lib/backend/marketplaceDiscovery";
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

// GET /api/market-materials
// Returns all public materials across users, newest first
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
        visibility: "public" 
      });

      if (!item) {
        return NextResponse.json({ error: "Material not found" }, { status: 404 });
      }

      return NextResponse.json(sanitizeMaterial(item));
    }

    // 2️⃣ Handle list fetch
    const { page, pageSize } = parsePagination(url.searchParams);

    const cacheKey = `market-materials:${url.searchParams.toString()}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return NextResponse.json(cached, { status: 200 });
    }

    const query = buildMarketplaceDiscoveryQuery(url.searchParams);
    const sort = buildMarketplaceSort(url.searchParams.get("sortBy"));

    const total = await db.collection("materials").countDocuments(query);
    const items = await db
      .collection("materials")
      .find(query)
      .sort(sort)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    const normalized = items.map(sanitizeMaterial);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const payload = { items: normalized, page, pageSize, total, totalPages };
    await cacheSet(cacheKey, payload, 600);

    return NextResponse.json(payload, { status: 200 });
  } catch (err) {
    if (err.name === "ValidationError") throw err;
    auditLog({ event: "market_materials_failed", route: "market-materials", method: "GET", status: 500, reason: err.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

import { NextResponse } from 'next/server';
import { CacheEngine } from '../../../lib/cache/engine';
import { client } from '../../../lib/backend/db';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const tenant = request.headers.get('x-tenant-id') || 'default';
    const network = request.headers.get('x-network-id') || 'mainnet';
    const materialId = searchParams.get('id');

    if (!materialId) {
      return NextResponse.json({ error: 'Missing material ID' }, { status: 400 });
    }

    const cacheKey = CacheEngine.buildKey('materials', {
      tenant, network, authScope: 'public', id: materialId
    });

    const systemConfig = await client.db().collection('system_meta').findOne({ id: 'global' });
    const currentSystemVersion = systemConfig?.version || 1;

    const data = await CacheEngine.getOrSet(
      'materials',
      cacheKey,
      async () => {
        return await client.db().collection('materials').findOne({ id: materialId, tenant, network });
      },
      currentSystemVersion
    );

    if (!data) {
      return NextResponse.json({ error: 'Material Not Found' }, { status: 404 });
    }

    return NextResponse.json({ data }, {
      headers: {
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'X-Cache-Provenance': cacheKey
      }
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
