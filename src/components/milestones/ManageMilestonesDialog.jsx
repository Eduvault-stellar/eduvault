"use client";

import { useState } from "react";
import Modal from "@/components/Modal";
import { useEscrowMilestones } from "@/hooks/useEscrow";
import { useMilestoneActions } from "@/hooks/useMilestoneActions";

const STATUS_BADGE = {
  pending: "bg-yellow-100 text-yellow-800",
  submitted: "bg-blue-100 text-blue-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  completed: "bg-gray-100 text-gray-800",
};

function StatusBadge({ status }) {
  const classes = STATUS_BADGE[status] || "bg-gray-100 text-gray-800";
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${classes}`}>
      {status}
    </span>
  );
}

export default function ManageMilestonesDialog({ escrowId, payoutId, isOpen, onClose }) {
  const { data: milestones = [], isLoading } = useEscrowMilestones(escrowId, { enabled: isOpen && !!escrowId });
  const actions = useMilestoneActions(escrowId);

  const [newMilestone, setNewMilestone] = useState({ title: "", amount: "", dueDate: "" });
  const [actionLoading, setActionLoading] = useState(null);

  async function handleCreate() {
    if (!newMilestone.title.trim()) return;
    setActionLoading("create");
    try {
      await actions.createMilestone.mutateAsync({
        payoutId,
        title: newMilestone.title,
        amount: newMilestone.amount,
        dueDate: newMilestone.dueDate || undefined,
      });
      setNewMilestone({ title: "", amount: "", dueDate: "" });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStatusChange(milestoneId, action, extra = {}) {
    setActionLoading(`${action}-${milestoneId}`);
    try {
      const fn = actions[`${action}Milestone`];
      if (fn) await fn.mutateAsync({ milestoneId, ...extra });
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage Milestones" ariaLabel="Manage milestones dialog">
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading milestones...</p>
      ) : (
        <div className="space-y-4">
          {milestones.length === 0 && (
            <p className="text-gray-500 text-sm">No milestones yet. Create one below.</p>
          )}

          {milestones.map((milestone) => (
            <div key={milestone.milestoneId} className="border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">
                  {milestone.order != null && `#${milestone.order} `}
                  {milestone.title || milestone.description || "Untitled"}
                </span>
                <StatusBadge status={milestone.status} />
              </div>

              {milestone.amount && (
                <p className="text-xs text-gray-600">
                  Amount: {milestone.amount} {milestone.currency || ""}
                </p>
              )}

              {milestone.dueDate && (
                <p className="text-xs text-gray-500">
                  Due: {new Date(milestone.dueDate).toLocaleDateString()}
                </p>
              )}

              {milestone.feedback && (
                <p className="text-xs text-gray-500 italic">Feedback: {milestone.feedback}</p>
              )}

              <div className="flex gap-1.5 flex-wrap">
                {milestone.status === "pending" && (
                  <button
                    type="button"
                    onClick={() => handleStatusChange(milestone.milestoneId, "submit")}
                    disabled={actionLoading === `submit-${milestone.milestoneId}`}
                    className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    Submit
                  </button>
                )}
                {milestone.status === "submitted" && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleStatusChange(milestone.milestoneId, "approve")}
                      disabled={actionLoading === `approve-${milestone.milestoneId}`}
                      className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleStatusChange(milestone.milestoneId, "reject", { reason: "Reviewed" })}
                      disabled={actionLoading === `reject-${milestone.milestoneId}`}
                      className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}

          <div className="border-t pt-3 space-y-2">
            <h3 className="text-sm font-medium">Add Milestone</h3>
            <input
              type="text"
              placeholder="Title"
              value={newMilestone.title}
              onChange={(e) => setNewMilestone((prev) => ({ ...prev, title: e.target.value }))}
              className="w-full border rounded px-2 py-1 text-sm"
            />
            <input
              type="text"
              placeholder="Amount"
              value={newMilestone.amount}
              onChange={(e) => setNewMilestone((prev) => ({ ...prev, amount: e.target.value }))}
              className="w-full border rounded px-2 py-1 text-sm"
            />
            <input
              type="date"
              value={newMilestone.dueDate}
              onChange={(e) => setNewMilestone((prev) => ({ ...prev, dueDate: e.target.value }))}
              className="w-full border rounded px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={actionLoading === "create" || !newMilestone.title.trim()}
              className="w-full text-xs px-3 py-1.5 bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50"
            >
              {actionLoading === "create" ? "Creating..." : "Create Milestone"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
