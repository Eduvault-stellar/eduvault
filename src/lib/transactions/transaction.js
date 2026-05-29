export const TransactionStatus = Object.freeze({
  Idle: "idle",
  WaitingWallet: "waiting_wallet",
  Signing: "signing",
  Submitting: "submitting",
  PendingConfirmation: "pending_confirmation",
  Confirmed: "confirmed",
  Failed: "failed",
  NeedsRetry: "needs_retry",
});

export const TransactionTone = Object.freeze({
  Neutral: "neutral",
  Info: "info",
  Success: "success",
  Warning: "warning",
  Danger: "danger",
});

export function createIdleTransaction(scope = "general") {
  return {
    id: null,
    scope,
    title: null,
    status: TransactionStatus.Idle,
    tone: TransactionTone.Neutral,
    message: null,
    detail: null,
    txHash: null,
    explorerUrl: null,
    retryable: false,
    error: null,
    startedAt: null,
    updatedAt: null,
    context: {},
  };
}

export function createTransactionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `tx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildExplorerUrl(txHash, explorerBaseUrl) {
  if (!txHash) return null;
  const base = explorerBaseUrl || process.env.NEXT_PUBLIC_STELLAR_EXPLORER_URL;
  if (!base) return null;

  const normalized = String(base).replace(/\/$/, "");
  return `${normalized}/${encodeURIComponent(txHash)}`;
}

export function classifyTransactionError(error) {
  const message = error instanceof Error ? error.message : String(error || "Transaction failed");
  const normalized = message.toLowerCase();

  if (/reject|cancel|dismiss|close|declin/.test(normalized)) {
    return {
      status: TransactionStatus.NeedsRetry,
      tone: TransactionTone.Warning,
      title: "Signature rejected",
      message: "The wallet request was cancelled before approval. You can try again when ready.",
      retryable: true,
      code: "rejected_signature",
    };
  }

  if (/timeout|timed out|confirmation timed out/.test(normalized)) {
    return {
      status: TransactionStatus.NeedsRetry,
      tone: TransactionTone.Warning,
      title: "Confirmation timed out",
      message: "The transaction was submitted, but confirmation took too long. You can retry or check the explorer.",
      retryable: true,
      code: "confirmation_timeout",
    };
  }

  if (/insufficient funds|not enough balance|low balance/.test(normalized)) {
    return {
      status: TransactionStatus.Failed,
      tone: TransactionTone.Danger,
      title: "Insufficient balance",
      message: "Add funds to your wallet and try again.",
      retryable: true,
      code: "insufficient_funds",
    };
  }

  if (/network|rpc|gateway|fetch|unavailable|503|failed to fetch/.test(normalized)) {
    return {
      status: TransactionStatus.NeedsRetry,
      tone: TransactionTone.Warning,
      title: "Network issue",
      message: "We could not reach the network or confirmation service. Retry when the connection is stable.",
      retryable: true,
      code: "network_error",
    };
  }

  if (/failed on-chain|transaction failed|reverted|revert/.test(normalized)) {
    return {
      status: TransactionStatus.Failed,
      tone: TransactionTone.Danger,
      title: "Transaction failed",
      message: message,
      retryable: true,
      code: "chain_failure",
    };
  }

  return {
    status: TransactionStatus.Failed,
    tone: TransactionTone.Danger,
    title: "Transaction failed",
    message,
    retryable: true,
    code: "unknown_error",
  };
}

export function getTransactionStepLabel(status) {
  switch (status) {
    case TransactionStatus.WaitingWallet:
      return "Waiting for wallet approval";
    case TransactionStatus.Signing:
      return "Opening wallet for signature";
    case TransactionStatus.Submitting:
      return "Submitting transaction";
    case TransactionStatus.PendingConfirmation:
      return "Awaiting confirmation";
    case TransactionStatus.Confirmed:
      return "Transaction confirmed";
    case TransactionStatus.NeedsRetry:
      return "Action needed";
    case TransactionStatus.Failed:
      return "Transaction failed";
    default:
      return "Ready";
  }
}

