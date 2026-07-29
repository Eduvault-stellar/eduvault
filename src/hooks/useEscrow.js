import { useQuery } from "@tanstack/react-query";

async function fetchEscrow(escrowId) {
  const res = await fetch(`/api/escrows/${escrowId}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error("Failed to fetch escrow");
  }
  return res.json();
}

async function fetchUserEscrows(walletAddress) {
  if (!walletAddress) return [];
  const res = await fetch(`/api/escrows?engager=${walletAddress}`);
  if (!res.ok) {
    throw new Error("Failed to fetch user escrows");
  }
  return res.json();
}

async function fetchEscrowMilestones(escrowId) {
  if (!escrowId) return [];
  const res = await fetch(`/api/escrows/${escrowId}/milestones`);
  if (!res.ok) {
    throw new Error("Failed to fetch milestones");
  }
  return res.json();
}

async function fetchEscrowOperation(idempotencyKey) {
  if (!idempotencyKey) return null;
  const res = await fetch(`/api/escrow-operations/${idempotencyKey}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error("Failed to fetch escrow operation");
  }
  return res.json();
}

export function getEscrowOperationStatus(operation) {
  if (!operation) return { state: "unknown", recoverable: false, pending: false, failed: false };
  const failed = operation.state === "failed";
  const pending = ["pending", "submitted", "reconciling"].includes(operation.state);
  return {
    state: operation.state,
    stage: operation.stage || null,
    pending,
    failed,
    recoverable: failed && operation.terminal !== true,
    retryCount: operation.retryCount || 0,
    reconciliationFailureCount: operation.reconciliationFailureCount || 0,
  };
}

export function useEscrow(escrowId, { enabled = true, refetchInterval = false } = {}) {
  return useQuery({
    queryKey: ["escrow", escrowId],
    queryFn: () => fetchEscrow(escrowId),
    enabled: enabled && !!escrowId,
    refetchInterval,
  });
}

export function useEscrowOperation(idempotencyKey, { enabled = true, refetchInterval = false } = {}) {
  return useQuery({
    queryKey: ["escrow-operation", idempotencyKey],
    queryFn: () => fetchEscrowOperation(idempotencyKey),
    enabled: enabled && !!idempotencyKey,
    refetchInterval,
    select: (operation) => ({
      operation,
      status: getEscrowOperationStatus(operation),
    }),
  });
}

export function useUserEscrows(walletAddress, { enabled = true } = {}) {
  return useQuery({
    queryKey: ["escrows", "user", walletAddress],
    queryFn: () => fetchUserEscrows(walletAddress),
    enabled: enabled && !!walletAddress,
  });
}

export function useEscrowMilestones(escrowId, { enabled = true, refetchInterval = false } = {}) {
  return useQuery({
    queryKey: ["escrow", escrowId, "milestones"],
    queryFn: () => fetchEscrowMilestones(escrowId),
    enabled: enabled && !!escrowId,
    refetchInterval,
  });
}
