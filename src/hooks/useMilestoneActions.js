import { useMutation, useQueryClient } from "@tanstack/react-query";

async function apiRequest(url, method, body) {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);
  return data;
}

export function useMilestoneActions(escrowId, { onSuccess, onError } = {}) {
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["escrow", escrowId, "milestones"] });
    queryClient.invalidateQueries({ queryKey: ["escrow", escrowId] });
  };

  const createMilestone = useMutation({
    mutationFn: (data) => apiRequest(`/api/escrows/${escrowId}/milestones`, "POST", data),
    onSuccess: () => { invalidate(); onSuccess?.("Milestone created"); },
    onError,
  });

  const updateMilestone = useMutation({
    mutationFn: ({ milestoneId, ...data }) =>
      apiRequest(`/api/milestones/${milestoneId}`, "PUT", data),
    onSuccess: () => { invalidate(); onSuccess?.("Milestone updated"); },
    onError,
  });

  const submitMilestone = useMutation({
    mutationFn: ({ milestoneId, reason }) =>
      apiRequest(`/api/milestones/${milestoneId}/submit`, "POST", { reason }),
    onSuccess: () => { invalidate(); onSuccess?.("Milestone submitted"); },
    onError,
  });

  const approveMilestone = useMutation({
    mutationFn: ({ milestoneId, reason, chainTxHash }) =>
      apiRequest(`/api/milestones/${milestoneId}/approve`, "POST", { reason, chainTxHash }),
    onSuccess: () => { invalidate(); onSuccess?.("Milestone approved"); },
    onError,
  });

  const rejectMilestone = useMutation({
    mutationFn: ({ milestoneId, reason }) =>
      apiRequest(`/api/milestones/${milestoneId}/reject`, "POST", { reason }),
    onSuccess: () => { invalidate(); onSuccess?.("Milestone rejected"); },
    onError,
  });

  const addEvidence = useMutation({
    mutationFn: ({ milestoneId, ...data }) =>
      apiRequest(`/api/milestones/${milestoneId}/evidence`, "POST", data),
    onSuccess: () => { invalidate(); onSuccess?.("Evidence added"); },
    onError,
  });

  return {
    createMilestone,
    updateMilestone,
    submitMilestone,
    approveMilestone,
    rejectMilestone,
    addEvidence,
  };
}
