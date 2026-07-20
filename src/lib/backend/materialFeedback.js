export const FEEDBACK_COLLECTION = "material_feedback";
export const MIN_FEEDBACK_SCORE = 1;
export const MAX_FEEDBACK_SCORE = 5;
export const MIN_FEEDBACK_COMMENT_LENGTH = 12;
export const MAX_FEEDBACK_COMMENT_LENGTH = 600;

export function normalizeAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getMaterialCreatorAddresses(material = {}) {
  return [
    material.userAddress,
    material.ownerAddress,
    material.creatorAddress,
    material.author?.walletAddress,
    material.author?.address,
  ]
    .map(normalizeAddress)
    .filter(Boolean);
}

export function isCreatorFeedback(material, reviewerAddress) {
  const reviewer = normalizeAddress(reviewerAddress);
  if (!reviewer) return false;
  return getMaterialCreatorAddresses(material).includes(reviewer);
}

export function validateFeedbackPayload(payload = {}) {
  const score = Number(payload.score ?? payload.rating);
  const comment = String(payload.comment ?? payload.body ?? "").trim();
  const errors = {};

  if (!Number.isFinite(score) || score < MIN_FEEDBACK_SCORE || score > MAX_FEEDBACK_SCORE) {
    errors.score = `Score must be between ${MIN_FEEDBACK_SCORE} and ${MAX_FEEDBACK_SCORE}.`;
  }

  if (!comment) {
    errors.comment = "Feedback comment is required.";
  } else if (comment.length < MIN_FEEDBACK_COMMENT_LENGTH) {
    errors.comment = `Feedback must be at least ${MIN_FEEDBACK_COMMENT_LENGTH} characters.`;
  } else if (comment.length > MAX_FEEDBACK_COMMENT_LENGTH) {
    errors.comment = `Feedback must be ${MAX_FEEDBACK_COMMENT_LENGTH} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    const error = new Error("Invalid feedback");
    error.name = "ValidationError";
    error.details = errors;
    throw error;
  }

  return {
    score: Math.round(score),
    comment,
  };
}

export function isVisibleFeedback(feedback = {}) {
  return feedback.status !== "hidden" && feedback.moderationStatus !== "rejected";
}

export function summarizeFeedback(items = []) {
  const visible = items.filter(isVisibleFeedback);
  if (visible.length === 0) {
    return {
      averageScore: 0,
      feedbackCount: 0,
    };
  }

  const total = visible.reduce((sum, item) => sum + (Number(item.score ?? item.rating) || 0), 0);
  const averageScore = Math.round((total / visible.length) * 10) / 10;

  return {
    averageScore,
    feedbackCount: visible.length,
  };
}

export function sanitizeFeedback(feedback = {}) {
  return {
    id: String(feedback._id || feedback.id || ""),
    materialId: String(feedback.materialId || ""),
    score: Number(feedback.score ?? feedback.rating) || 0,
    rating: Number(feedback.score ?? feedback.rating) || 0,
    comment: feedback.comment || "",
    reviewerAddress: feedback.reviewerAddress || "",
    reviewerName: feedback.reviewerName || "",
    verifiedBuyer: Boolean(feedback.verifiedBuyer),
    moderationStatus: feedback.moderationStatus || "pending_review",
    status: feedback.status || "published",
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
  };
}

export function feedbackModerationPlaceholder() {
  return {
    status: "pending_review",
    label: "Basic moderation placeholder",
    message: "Feedback is published immediately and queued for future moderation review.",
  };
}
