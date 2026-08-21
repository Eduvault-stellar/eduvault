import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveCreatorLedgerAnalytics,
  LedgerAnalyticsError,
} from "../../src/lib/ledger/analytics.js";
import { createTransaction, EVENT_TYPES, SETTLEMENT_STATES } from "../../src/lib/ledger/journal.js";
import { toStroops } from "../../src/lib/ledger/money.js";
import { postPurchase, postRefund } from "../../src/lib/ledger/postingRules.js";

const ASSET = "USDC:GISSUER";

function transaction({ id, eventType, lines, occurredAt, settlementState = SETTLEMENT_STATES.SETTLED }) {
  return {
    ...createTransaction({
      eventType,
      source: { network: "test", txHash: id, opIndex: 0 },
      lines,
      occurredAt,
      settlementState,
    }),
    id,
  };
}

test("derives settled, pending, refund, and chart earnings only from journal lines", () => {
  const purchase = postPurchase({
    gross: toStroops("100"),
    feeBps: 250,
    assetKey: ASSET,
    creatorId: "creator-1",
  });
  const refund = postRefund({
    amount: toStroops("40"),
    original: {
      net: toStroops("100"),
      proceeds: toStroops("97.5"),
      creatorId: "creator-1",
      assetKey: ASSET,
    },
  });
  const pending = postPurchase({
    gross: toStroops("20"),
    feeBps: 250,
    assetKey: ASSET,
    creatorId: "creator-1",
  });
  const transactions = [
    transaction({ id: "buy", eventType: EVENT_TYPES.PURCHASE, lines: purchase.lines, occurredAt: "2026-08-19T12:00:00Z" }),
    transaction({ id: "refund", eventType: EVENT_TYPES.REFUND, lines: refund.lines, occurredAt: "2026-08-20T12:00:00Z" }),
    transaction({
      id: "pending",
      eventType: EVENT_TYPES.PURCHASE,
      lines: pending.lines,
      occurredAt: "2026-08-20T14:00:00Z",
      settlementState: SETTLEMENT_STATES.PENDING,
    }),
  ];

  const result = deriveCreatorLedgerAnalytics(transactions, "creator-1", {
    requestedAsset: ASSET,
    from: new Date("2026-08-01T00:00:00Z"),
    to: new Date("2026-08-21T23:59:59Z"),
  });

  assert.equal(result.totalRevenue, "58.5");
  assert.equal(result.pendingRevenue, "19.5");
  assert.equal(result.totalEarnings, "78");
  assert.equal(result.completedOrders, 1);
  assert.equal(result.periodOrders, 1);
  assert.equal(result.chart.find((day) => day.date === "2026-08-19").revenue, "97.5");
  assert.equal(result.chart.find((day) => day.date === "2026-08-20").revenue, "-39");
});

test("keeps assets separate instead of summing unlike currencies", () => {
  const usdc = postPurchase({ gross: toStroops("10"), feeBps: 0, assetKey: ASSET, creatorId: "creator-1" });
  const xlm = postPurchase({ gross: toStroops("3"), feeBps: 0, assetKey: "native", creatorId: "creator-1" });
  const result = deriveCreatorLedgerAnalytics([
    transaction({ id: "usdc", eventType: EVENT_TYPES.PURCHASE, lines: usdc.lines, occurredAt: "2026-08-21T10:00:00Z" }),
    transaction({ id: "xlm", eventType: EVENT_TYPES.PURCHASE, lines: xlm.lines, occurredAt: "2026-08-21T11:00:00Z" }),
  ], "creator-1", { to: new Date("2026-08-21T23:59:59Z") });

  assert.equal(result.assetKey, "native");
  assert.deepEqual(
    Object.fromEntries(result.balances.map((balance) => [balance.assetKey, balance.total])),
    { [ASSET]: "10", native: "3" },
  );
});

test("fails closed when immutable journal data is unbalanced", () => {
  assert.throws(
    () => deriveCreatorLedgerAnalytics([
      {
        id: "corrupt",
        eventType: EVENT_TYPES.PURCHASE,
        settlementState: SETTLEMENT_STATES.SETTLED,
        occurredAt: "2026-08-21T00:00:00Z",
        lines: [{
          account: "creator_payable",
          subaccount: "creator-1",
          assetKey: ASSET,
          direction: "credit",
          amount: "100",
        }],
      },
    ], "creator-1"),
    LedgerAnalyticsError,
  );
});
