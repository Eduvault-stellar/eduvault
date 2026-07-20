import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  feedbackModerationPlaceholder,
  isCreatorFeedback,
  sanitizeFeedback,
  summarizeFeedback,
  validateFeedbackPayload,
} from "../../src/lib/backend/materialFeedback.js";

describe("material feedback helpers", () => {
  it("validates score and comment payloads", () => {
    assert.deepEqual(validateFeedbackPayload({ score: 4, comment: "Very useful lecture notes." }), {
      score: 4,
      comment: "Very useful lecture notes.",
    });

    assert.throws(
      () => validateFeedbackPayload({ score: 7, comment: "Too short" }),
      (error) => {
        assert.equal(error.name, "ValidationError");
        assert.equal(error.details.score, "Score must be between 1 and 5.");
        assert.equal(error.details.comment, "Feedback must be at least 12 characters.");
        return true;
      }
    );
  });

  it("detects creator self-scoring across creator address fields", () => {
    const material = {
      userAddress: "GCREATOR123",
      author: { walletAddress: "GAUTHOR456" },
    };

    assert.equal(isCreatorFeedback(material, "gcreator123"), true);
    assert.equal(isCreatorFeedback(material, "gauthor456"), true);
    assert.equal(isCreatorFeedback(material, "glearner789"), false);
  });

  it("summarizes only visible feedback", () => {
    const summary = summarizeFeedback([
      { score: 5, status: "published" },
      { score: 3, status: "published" },
      { score: 1, status: "hidden" },
      { score: 2, moderationStatus: "rejected" },
    ]);

    assert.deepEqual(summary, {
      averageScore: 4,
      feedbackCount: 2,
    });
  });

  it("sanitizes feedback and exposes the moderation placeholder", () => {
    assert.deepEqual(
      sanitizeFeedback({
        _id: "abc123",
        materialId: "mat123",
        score: 5,
        comment: "Great notes for revision.",
        reviewerAddress: "GLEARNER",
        moderationStatus: "pending_review",
      }),
      {
        id: "abc123",
        materialId: "mat123",
        score: 5,
        rating: 5,
        comment: "Great notes for revision.",
        reviewerAddress: "GLEARNER",
        reviewerName: "",
        verifiedBuyer: false,
        moderationStatus: "pending_review",
        status: "published",
        createdAt: undefined,
        updatedAt: undefined,
      }
    );

    assert.equal(feedbackModerationPlaceholder().status, "pending_review");
  });
});
