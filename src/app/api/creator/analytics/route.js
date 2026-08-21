export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ACCOUNTS } from "@/lib/ledger/accounts";
import {
  creatorTransactionDelta,
  deriveCreatorLedgerAnalytics,
  LedgerAnalyticsError,
} from "@/lib/ledger/analytics";
import { EVENT_TYPES, SETTLEMENT_STATES } from "@/lib/ledger/journal";
import { fromStroops } from "@/lib/ledger/money";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseDateRange(url) {
  const to = url.searchParams.get("to") ? new Date(url.searchParams.get("to")) : new Date();
  const from = url.searchParams.get("from")
    ? new Date(url.searchParams.get("from"))
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new RangeError("Invalid analytics date range");
  }
  return { from, to };
}

function materialKeys(material) {
  return [material?._id, material?.materialId].filter(Boolean).map(String);
}

function activity(material) {
  return (
    Number(material.views ?? material.viewCount ?? 0) +
    Number(material.downloads ?? material.downloadCount ?? 0) +
    Number(material.reviewsCount ?? material.reviewCount ?? 0)
  );
}

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function analyticsResponse(request) {
  const user = await getUserFromCookie(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const creatorId = user.walletAddress || user.address || user.sub;
  if (!creatorId) return NextResponse.json({ error: "No creator identity on account" }, { status: 400 });

  let range;
  try {
    range = parseDateRange(new URL(request.url));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const url = new URL(request.url);
  const requestedAsset = url.searchParams.get("asset") || null;
  const db = await getDb();
  const [transactions, creatorMaterials] = await Promise.all([
    db.collection("ledger_transactions")
      .find({
        lines: {
          $elemMatch: {
            account: ACCOUNTS.CREATOR_PAYABLE,
            subaccount: String(creatorId),
          },
        },
      })
      .sort({ occurredAt: 1, postedAt: 1 })
      .toArray(),
    db.collection("materials")
      .find(
        { userAddress: creatorId },
        {
          projection: {
            _id: 1,
            materialId: 1,
            title: 1,
            visibility: 1,
            createdAt: 1,
            views: 1,
            viewCount: 1,
            downloads: 1,
            downloadCount: 1,
            reviewsCount: 1,
            reviewCount: 1,
          },
        },
      )
      .toArray(),
  ]);

  const ledger = deriveCreatorLedgerAnalytics(transactions, creatorId, {
    requestedAsset,
    from: range.from,
    to: range.to,
  });
  const materialIds = [...new Set(creatorMaterials.flatMap(materialKeys))];
  const savedDocs = materialIds.length
    ? await db.collection("saved_materials").find({ materialId: { $in: materialIds } }).toArray()
    : [];
  const pendingCount = transactions.filter((transaction) => {
    if (transaction.settlementState !== SETTLEMENT_STATES.PENDING) return false;
    return creatorTransactionDelta(transaction, creatorId, ledger.assetKey) > 0n;
  }).length;

  const materialFinancials = new Map();
  for (const transaction of transactions) {
    const materialId = transaction.metadata?.materialId;
    if (!materialId || transaction.settlementState === SETTLEMENT_STATES.PENDING) continue;
    const key = String(materialId);
    const totals = materialFinancials.get(key) || { revenue: 0n, sales: 0 };
    const delta = creatorTransactionDelta(transaction, creatorId, ledger.assetKey);
    totals.revenue += delta;
    if (transaction.eventType === EVENT_TYPES.PURCHASE && delta > 0n) totals.sales += 1;
    materialFinancials.set(key, totals);
  }

  const saveCounts = new Map();
  for (const saved of savedDocs) {
    const key = String(saved.materialId);
    saveCounts.set(key, (saveCounts.get(key) || 0) + 1);
  }
  const topMaterials = creatorMaterials
    .map((material) => {
      const keys = materialKeys(material);
      const financial = keys.reduce(
        (total, key) => {
          const next = materialFinancials.get(key);
          return {
            revenue: total.revenue + (next?.revenue || 0n),
            sales: total.sales + (next?.sales || 0),
          };
        },
        { revenue: 0n, sales: 0 },
      );
      return {
        id: keys[0],
        name: material.title || "Untitled material",
        sales: financial.sales,
        completedOrders: financial.sales,
        revenue: fromStroops(financial.revenue),
        learnerInterest: keys.reduce((sum, key) => sum + (saveCounts.get(key) || 0), 0),
        activity: activity(material),
        visibility: material.visibility || "private",
        uploadedAt: material.createdAt || null,
      };
    })
    .sort((a, b) => b.sales - a.sales || Number(b.learnerInterest) - Number(a.learnerInterest))
    .slice(0, 5);

  const titleById = new Map();
  for (const material of creatorMaterials) {
    for (const key of materialKeys(material)) titleById.set(key, material.title || "Untitled material");
  }
  const recentOrders = transactions
    .filter((transaction) => {
      if (transaction.eventType !== EVENT_TYPES.PURCHASE) return false;
      return creatorTransactionDelta(transaction, creatorId, ledger.assetKey) > 0n;
    })
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .slice(0, 5)
    .map((transaction) => {
      const amount = creatorTransactionDelta(transaction, creatorId, ledger.assetKey);
      const materialId = transaction.metadata?.materialId ? String(transaction.metadata.materialId) : null;
      return {
        id: transaction.id,
        material: titleById.get(materialId) || "Ledger purchase",
        buyer: transaction.metadata?.buyerAddress || "Not recorded",
        amount: fromStroops(amount),
        assetKey: ledger.assetKey,
        status: transaction.settlementState,
        date: displayDate(transaction.occurredAt),
      };
    });

  const sevenDayUploads = new Map();
  const sevenDayInterest = new Map();
  for (const material of creatorMaterials) {
    const date = new Date(material.createdAt || 0);
    if (!Number.isNaN(date.getTime())) {
      const key = date.toISOString().slice(0, 10);
      sevenDayUploads.set(key, (sevenDayUploads.get(key) || 0) + 1);
    }
  }
  for (const saved of savedDocs) {
    const date = new Date(saved.savedAt || 0);
    if (!Number.isNaN(date.getTime())) {
      const key = date.toISOString().slice(0, 10);
      sevenDayInterest.set(key, (sevenDayInterest.get(key) || 0) + 1);
    }
  }
  const chartData = ledger.chart.map((day) => {
    const date = new Date(`${day.date}T00:00:00.000Z`);
    return {
      day: DAY_LABELS[date.getUTCDay()],
      date: day.date,
      revenue: day.revenue,
      revenueStroops: day.revenueStroops,
      orders: day.orders,
      uploads: sevenDayUploads.get(day.date) || 0,
      interest: sevenDayInterest.get(day.date) || 0,
    };
  });

  const publishedCount = creatorMaterials.filter((material) => material.visibility !== "private").length;
  const materialActivity = creatorMaterials.reduce((sum, material) => sum + activity(material), 0);
  const learnerInterest = savedDocs.length + pendingCount;
  return NextResponse.json({
    ledgerSource: "ledger_transactions",
    assetKey: ledger.assetKey,
    earningsByAsset: ledger.balances,
    totalRevenue: ledger.totalRevenue,
    pendingRevenue: ledger.pendingRevenue,
    totalEarnings: ledger.totalEarnings,
    totalSales: ledger.completedOrders,
    completedOrders: ledger.completedOrders,
    monthlySales: ledger.periodOrders,
    pendingCount,
    indexingCount: 0,
    uploadCount: creatorMaterials.length,
    publishedCount,
    draftCount: creatorMaterials.length - publishedCount,
    materialActivity,
    learnerInterest,
    savedCount: savedDocs.length,
    hasActivity: creatorMaterials.length > 0 || transactions.length > 0 || savedDocs.length > 0,
    chartData,
    topMaterials,
    recentOrders,
    withdrawals: [],
    dateRange: { from: range.from.toISOString(), to: range.to.toISOString() },
  });
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "creator-analytics", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        return await analyticsResponse(request);
      } catch (error) {
        auditLog({
          event: "creator_analytics_failed",
          route: "creator/analytics",
          method: "GET",
          status: 500,
          reason: error instanceof LedgerAnalyticsError ? error.name : "analytics_error",
          transactionId: error instanceof LedgerAnalyticsError ? error.transactionId : undefined,
        });
        return NextResponse.json({ error: "Unable to derive creator analytics" }, { status: 500 });
      }
    },
  );
}
