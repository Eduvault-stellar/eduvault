import { describe, it, expect } from "vitest";

import {
  buildExplorerUrl,
  classifyTransactionError,
  createIdleTransaction,
  TransactionStatus,
  TransactionTone,
} from "./transaction";

describe("transaction helpers", () => {
  it("creates a neutral idle transaction", () => {
    const tx = createIdleTransaction("purchase");

    expect(tx.scope).toBe("purchase");
    expect(tx.status).toBe(TransactionStatus.Idle);
    expect(tx.tone).toBe(TransactionTone.Neutral);
  });

  it("classifies wallet rejection as retryable", () => {
    const failure = classifyTransactionError(new Error("User rejected the request"));

    expect(failure.status).toBe(TransactionStatus.NeedsRetry);
    expect(failure.retryable).toBe(true);
    expect(failure.title).toMatch(/signature/i);
  });

  it("classifies confirmation timeout as retryable", () => {
    const failure = classifyTransactionError("Transaction confirmation timed out");

    expect(failure.status).toBe(TransactionStatus.NeedsRetry);
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("confirmation_timeout");
  });

  it("builds explorer links when a base url is available", () => {
    expect(buildExplorerUrl("abc123", "https://stellar.expert/explorer/testnet/tx")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123",
    );
  });
});

