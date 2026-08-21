import { ACCOUNTS } from "./accounts.js";
import { assertBalanced, EVENT_TYPES, SETTLEMENT_STATES } from "./journal.js";
import { asStroops, fromStroops } from "./money.js";

export class LedgerAnalyticsError extends Error {
  constructor(message, transactionId = null) {
    super(message);
    this.name = "LedgerAnalyticsError";
    this.transactionId = transactionId;
  }
}

export function creatorTransactionDelta(transaction, creatorId, assetKey) {
  try {
    assertBalanced(transaction.lines);
  } catch {
    throw new LedgerAnalyticsError("Unbalanced or invalid ledger transaction", transaction.id || null);
  }

  let delta = 0n;
  for (const line of transaction.lines) {
    if (
      line.account !== ACCOUNTS.CREATOR_PAYABLE ||
      String(line.subaccount) !== String(creatorId) ||
      line.assetKey !== assetKey
    ) {
      continue;
    }
    const amount = asStroops(line.amount);
    delta += line.direction === "credit" ? amount : -amount;
  }
  return delta;
}

function creatorAssets(transactions, creatorId) {
  const assets = new Set();
  for (const transaction of transactions) {
    for (const line of transaction.lines || []) {
      if (
        line.account === ACCOUNTS.CREATOR_PAYABLE &&
        String(line.subaccount) === String(creatorId)
      ) {
        assets.add(line.assetKey);
      }
    }
  }
  return [...assets].sort();
}

function selectAsset(assets, requestedAsset) {
  if (requestedAsset) return requestedAsset;
  if (assets.includes("native")) return "native";
  return assets[0] || "native";
}

function emptyDay(date) {
  return {
    date: date.toISOString().slice(0, 10),
    revenueStroops: 0n,
    orders: 0,
  };
}

export function deriveCreatorLedgerAnalytics(
  transactions,
  creatorId,
  { requestedAsset = null, from, to, chartDays = 7 } = {},
) {
  const assets = creatorAssets(transactions, creatorId);
  const assetKey = selectAsset(assets, requestedAsset);
  const balances = assets.map((key) => {
    let available = 0n;
    let pending = 0n;
    for (const transaction of transactions) {
      const delta = creatorTransactionDelta(transaction, creatorId, key);
      if (transaction.settlementState === SETTLEMENT_STATES.PENDING) pending += delta;
      else available += delta;
    }
    return {
      assetKey: key,
      available: fromStroops(available),
      pending: fromStroops(pending),
      total: fromStroops(available + pending),
      availableStroops: available.toString(),
      pendingStroops: pending.toString(),
      totalStroops: (available + pending).toString(),
    };
  });
  const selected = balances.find((entry) => entry.assetKey === assetKey) || {
    available: "0",
    pending: "0",
    total: "0",
  };

  const end = to ? new Date(to) : new Date();
  const chartStart = new Date(end);
  chartStart.setUTCHours(0, 0, 0, 0);
  chartStart.setUTCDate(chartStart.getUTCDate() - (chartDays - 1));
  const days = Array.from({ length: chartDays }, (_, index) => {
    const date = new Date(chartStart);
    date.setUTCDate(date.getUTCDate() + index);
    return emptyDay(date);
  });
  const dayMap = new Map(days.map((day) => [day.date, day]));

  let completedOrders = 0;
  let periodOrders = 0;
  for (const transaction of transactions) {
    const occurredAt = new Date(transaction.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new LedgerAnalyticsError("Ledger transaction has an invalid occurredAt", transaction.id || null);
    }
    const delta = creatorTransactionDelta(transaction, creatorId, assetKey);
    const isSettledPurchase =
      transaction.eventType === EVENT_TYPES.PURCHASE &&
      transaction.settlementState !== SETTLEMENT_STATES.PENDING &&
      delta > 0n;
    if (isSettledPurchase) completedOrders += 1;

    if (from && occurredAt < new Date(from)) continue;
    if (to && occurredAt > new Date(to)) continue;
    if (isSettledPurchase) periodOrders += 1;

    if (transaction.settlementState === SETTLEMENT_STATES.PENDING) continue;
    const day = dayMap.get(occurredAt.toISOString().slice(0, 10));
    if (day) {
      day.revenueStroops += delta;
      if (isSettledPurchase) day.orders += 1;
    }
  }

  return {
    assetKey,
    balances,
    totalRevenue: selected.available,
    pendingRevenue: selected.pending,
    totalEarnings: selected.total,
    completedOrders,
    periodOrders,
    chart: days.map((day) => ({
      date: day.date,
      revenue: fromStroops(day.revenueStroops),
      revenueStroops: day.revenueStroops.toString(),
      orders: day.orders,
    })),
  };
}
