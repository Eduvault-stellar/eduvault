import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─── Date range helpers ───────────────────────────────────────────────────────

/**
 * Parse optional `from` / `to` query parameters into Date objects.
 * Falls back to sensible defaults when the params are absent or invalid.
 *
 * @param {URL} url
 * @returns {{ from: Date, to: Date }}
 */
function parseDateRange(url) {
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const to = toParam ? new Date(toParam) : new Date();
  // Default "from" is 30 days before "to"
  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Guard against invalid dates
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    const fallbackTo = new Date();
    return {
      from: new Date(fallbackTo.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: fallbackTo,
    };
  }

  return { from, to };
}

// ─── GET /api/creator/analytics ───────────────────────────────────────────────
//
// Query params (all optional):
//   from  ISO-8601 date string — start of the reporting window (default: 30 days ago)
//   to    ISO-8601 date string — end   of the reporting window (default: now)
//
// Response shape:
//   {
//     totalRevenue:     number,          // sum of confirmed purchase amounts (all time)
//     totalSales:       number,          // count of confirmed purchases (all time)
//     monthlySales:     number,          // confirmed purchases within the date window
//     pendingCount:     number,          // purchases with status "pending"
//     indexingCount:    number,          // purchases with status "indexing"
//     lastIndexedLedger: number | null,  // most recent Stellar ledger indexed (from syncState)
//     chartData:        Array<{ day: string, value: number }>, // daily revenue (last 7 days)
//     topMaterials:     Array<{ name, sales, revenue }>,
//     withdrawals:      Array<{ date, amount, status }>,
//   }

export async function GET(request) {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const creatorAddress = user.walletAddress;
    if (!creatorAddress) {
      return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
    }

    const url = new URL(request.url);
    const { from, to } = parseDateRange(url);

    const db = await getDb();
    const purchases = db.collection("purchases");
    const materials = db.collection("materials");

    // ── 1. Fetch all material IDs owned by this creator ──────────────────────
    const creatorMaterials = await materials
      .find({ userAddress: creatorAddress }, { projection: { _id: 1, title: 1 } })
      .toArray();

    const materialIdStrings = creatorMaterials.map((m) => m._id.toString());
    const materialTitleMap = Object.fromEntries(
      creatorMaterials.map((m) => [m._id.toString(), m.title ?? "Untitled"])
    );

    // ── 2. Total Revenue & Total Sales (all time, confirmed) ─────────────────
    const allTimeAgg = await purchases
      .aggregate([
        {
          $match: {
            materialId: { $in: materialIdStrings },
            status: "confirmed",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $toDouble: "$amount" } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const totalRevenue = allTimeAgg[0]?.total ?? 0;
    const totalSales = allTimeAgg[0]?.count ?? 0;

    // ── 3. Date-windowed Sales count ─────────────────────────────────────────
    const monthlySalesAgg = await purchases
      .aggregate([
        {
          $match: {
            materialId: { $in: materialIdStrings },
            status: "confirmed",
            purchasedAt: { $gte: from, $lte: to },
          },
        },
        { $count: "count" },
      ])
      .toArray();

    const monthlySales = monthlySalesAgg[0]?.count ?? 0;

    // ── 4. Pending and Indexing purchase counts ───────────────────────────────
    const pendingAgg = await purchases
      .aggregate([
        {
          $match: {
            materialId: { $in: materialIdStrings },
            status: { $in: ["pending", "indexing"] },
          },
        },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const pendingCount =
      pendingAgg.find((g) => g._id === "pending")?.count ?? 0;
    const indexingCount =
      pendingAgg.find((g) => g._id === "indexing")?.count ?? 0;

    // ── 5. Last indexed Stellar ledger from syncState ─────────────────────────
    let lastIndexedLedger = null;
    try {
      const syncState = db.collection("syncState");
      const state = await syncState.findOne({});
      if (typeof state?.lastLedger === "number") {
        lastIndexedLedger = state.lastLedger;
      }
    } catch {
      // syncState collection may not exist yet — return null gracefully
    }

    // ── 6. Chart Data — daily revenue for last 7 days ────────────────────────
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const chartAgg = await purchases
      .aggregate([
        {
          $match: {
            materialId: { $in: materialIdStrings },
            status: "confirmed",
            purchasedAt: { $gte: sevenDaysAgo },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$purchasedAt" },
            },
            value: { $sum: { $toDouble: "$amount" } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    // Fill in any missing days so the chart always has 7 points
    const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const chartMap = Object.fromEntries(chartAgg.map((d) => [d._id, d.value]));
    const chartData = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      return {
        day: DAY_LABELS[d.getDay()],
        value: chartMap[key] ?? 0,
      };
    });

    // ── 7. Top 5 Materials by sales count ────────────────────────────────────
    const topMaterialsAgg = await purchases
      .aggregate([
        {
          $match: {
            materialId: { $in: materialIdStrings },
            status: "confirmed",
          },
        },
        {
          $group: {
            _id: "$materialId",
            sales: { $sum: 1 },
            revenue: { $sum: { $toDouble: "$amount" } },
          },
        },
        { $sort: { sales: -1 } },
        { $limit: 5 },
      ])
      .toArray();

    const topMaterials = topMaterialsAgg.map((m) => ({
      name: materialTitleMap[m._id] ?? "Unknown Material",
      sales: m.sales,
      revenue: `$${m.revenue.toFixed(2)}`,
    }));

    // ── 8. Recent 5 Withdrawals ───────────────────────────────────────────────
    // Gracefully handle the case where the payouts collection doesn't exist yet
    let withdrawals = [];
    try {
      const payouts = db.collection("payouts");
      const payoutDocs = await payouts
        .find({ creatorAddress })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();

      withdrawals = payoutDocs.map((p) => ({
        date: new Date(p.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        amount: `$${Number(p.amount ?? 0).toFixed(2)}`,
        status: p.status === "completed" ? "Success" : "Pending",
      }));
    } catch {
      // payouts collection not yet created — return empty array
    }

    return NextResponse.json({
      totalRevenue,
      totalSales,
      monthlySales,
      pendingCount,
      indexingCount,
      lastIndexedLedger,
      chartData,
      topMaterials,
      withdrawals,
      // Echo back the applied date range so the frontend can display it
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    });
  } catch (error) {
    console.error("[analytics] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
