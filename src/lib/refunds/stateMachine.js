/**
 * Refund claim lifecycle (#27).
 *
 * A refund is a durable, policy-enforced state machine bound to a settled
 * purchase receipt. States move only through explicitly allowed transitions
 * and every mutation is guarded by a compare-and-set status filter so
 * concurrent approvals, retries, and process restarts can never double-pay.
 *
 *   requested -> approved  -> submitting -> pending -> settled
 *        \            \          \    \        \
 *         -> rejected   -> rejected \    -> failed
 *                                   -> approved   (crash recovery, no hash seen)
 *   pending -> failed                          (on-chain tx not successful)
 */

export const REFUND_STATES = {
  REQUESTED: "requested",
  APPROVED: "approved",
  SUBMITTING: "submitting",
  PENDING: "pending",
  SETTLED: "settled",
  FAILED: "failed",
  REJECTED: "rejected",
};

export const REFUND_TRANSITIONS = {
  [REFUND_STATES.REQUESTED]: [REFUND_STATES.APPROVED, REFUND_STATES.REJECTED],
  [REFUND_STATES.APPROVED]: [
    REFUND_STATES.SUBMITTING,
    REFUND_STATES.REJECTED,
  ],
  [REFUND_STATES.SUBMITTING]: [
    REFUND_STATES.PENDING,
    REFUND_STATES.FAILED,
    // Crash recovery: the submitter died before Horizon saw anything and no
    // transaction hash was recorded. Rolling back to `approved` keeps the
    // claim payable without ever risking a second effective payment.
    REFUND_STATES.APPROVED,
  ],
  [REFUND_STATES.PENDING]: [REFUND_STATES.SETTLED, REFUND_STATES.FAILED],
  [REFUND_STATES.SETTLED]: [],
  [REFUND_STATES.FAILED]: [],
  [REFUND_STATES.REJECTED]: [],
};

// States that hold or will hold treasury funds; only one may exist per
// purchase at any time.
export const ACTIVE_REFUND_STATES = [
  REFUND_STATES.REQUESTED,
  REFUND_STATES.APPROVED,
  REFUND_STATES.SUBMITTING,
  REFUND_STATES.PENDING,
];

// `settled` refunds already moved funds, so they count toward the refunded
// total even though they no longer occupy the active slot.
export const EFFECTIVE_REFUND_STATUSES = [
  ...ACTIVE_REFUND_STATES,
  REFUND_STATES.SETTLED,
];

export function canRefundTransition(currentState, targetState) {
  const allowed = REFUND_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(targetState);
}

export function assertRefundTransition(currentState, targetState) {
  if (!canRefundTransition(currentState, targetState)) {
    throw new Error(
      `Invalid refund transition from '${currentState}' to '${targetState}'`
    );
  }
}
