import { describe, it, expect, vi } from "vitest";
import { WalletIntentError } from "../lib/wallet/intent.js";

const { verifyWalletTransactionIntent, formatWalletIntent } = await import("../lib/wallet/intent.js");

vi.mock("@stellar/stellar-sdk", () => {
  const MockTransactionBuilder = vi.fn().mockImplementation(() => ({
    source: "GADDR",
    operations: [],
  }));
  MockTransactionBuilder.fromXDR = vi.fn();

  return {
    TransactionBuilder: MockTransactionBuilder,
    Networks: {
      PUBLIC: "Public Global Stellar Network ; September 2015",
      TESTNET: "Test SDF Network ; September 2015",
    },
  };
});

describe("verifyWalletTransactionIntent", () => {
  it("requires a non-empty intent summary", async () => {
    await expect(verifyWalletTransactionIntent({
      xdr: "base64xdr",
      address: "GADDR",
      networkPassphrase: "Testnet",
      intent: {},
    })).rejects.toThrow("wallet_intent_required");
  });

  it("matches network passphrase on parseable XDR", async () => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    TransactionBuilder.fromXDR = vi.fn(() => ({
      source: "GADDR",
      operations: [],
    }));

    await expect(verifyWalletTransactionIntent({
      xdr: "base64xdr",
      address: "GADDR",
      networkPassphrase: "Mismatched Network",
      intent: {
        summary: "Pay for material",
        networkPassphrase: "Testnet",
        operation: "payment",
        destination: "GDEST",
        amount: "3.5",
        asset: "XLM",
        operationCount: 1,
        operationIndex: 0,
      },
    })).rejects.toThrow("network");
  });

  it("matches operation destination for payment", async () => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const mockTx = {
      source: "GADDR",
      operations: [
        {
          type: "payment",
          destination: "GDEST",
          amount: "35000000",
          asset: { isNative: () => true, code: null, issuer: null },
        },
      ],
    };
    TransactionBuilder.fromXDR = vi.fn(() => mockTx);

    await expect(verifyWalletTransactionIntent({
      xdr: "base64xdr",
      address: "GADDR",
      networkPassphrase: "Testnet",
      intent: {
        summary: "Pay for material",
        networkPassphrase: "Testnet",
        operation: "payment",
        destination: "GDEST_WRONG",
        amount: "3.5",
        asset: "XLM",
        operationCount: 1,
        operationIndex: 0,
      },
    })).rejects.toThrow("recipient");
  });

  it("returns source and operation on valid intent", async () => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const mockTx = {
      source: "GADDR",
      operations: [
        {
          type: "payment",
          destination: "GDEST",
          amount: "35000000",
          asset: { isNative: () => true, code: null, issuer: null },
        },
      ],
    };
    TransactionBuilder.fromXDR = vi.fn(() => mockTx);

    const result = await verifyWalletTransactionIntent({
      xdr: "base64xdr",
      address: "GADDR",
      networkPassphrase: "Testnet",
      intent: {
        summary: "Pay for material",
        networkPassphrase: "Testnet",
        operation: "payment",
        destination: "GDEST",
        amount: "3.5",
        asset: "XLM",
        operationCount: 1,
        operationIndex: 0,
      },
    });

    expect(result.source).toBe("GADDR");
    expect(result.operation).toBe("payment");
  });
});

describe("formatWalletIntent", () => {
  it("formats human-readable payment intent", () => {
    const formatted = formatWalletIntent({
      summary: "Pay for material",
      networkPassphrase: "Test SDF Network ; September 2015",
      operation: "payment",
      destination: "GDEST",
      amount: "3.5",
      asset: "XLM",
    });

    expect(formatted).toContain("Requested action: Pay for material");
    expect(formatted).toContain("Stellar Testnet");
    expect(formatted).toContain("Recipient: GDEST");
    expect(formatted).toContain("Amount: 3.5 XLM");
  });

  it("handles contract invocation intent", () => {
    const formatted = formatWalletIntent({
      summary: "Purchase access",
      networkPassphrase: "Test SDF Network ; September 2015",
      operation: "invokeHostFunction",
      contractId: "CAOZQEXAMPLE",
      amount: "100",
      functionName: "purchase",
    });

    expect(formatted).toContain("Contract: CAOZQEXAMPLE");
    expect(formatted).toContain("Action: purchase");
    expect(formatted).toContain("Amount: 100 contract units");
  });
});
