import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MaterialReviewPanelView } from "./MaterialReviewPanel";

function renderPanel(props = {}) {
  return render(
    <MaterialReviewPanelView
      materialId="mat-101"
      currentAddress="GBUYER1234567890"
      creatorAddress="GCREATOR1234567890"
      initialReviews={[]}
      feedbackData={{
        items: [],
        averageScore: 0,
        feedbackCount: 0,
        moderation: {
          label: "Basic moderation placeholder",
          message: "Feedback is published immediately and queued for future moderation review.",
        },
      }}
      submitFeedback={vi.fn().mockResolvedValue({})}
      {...props}
    />,
  );
}

describe("MaterialReviewPanel", () => {
  it("renders the empty feedback state and moderation placeholder", () => {
    renderPanel();

    expect(screen.getByText("No feedback has been published yet.")).toBeInTheDocument();
    expect(screen.getByText("No feedback yet")).toBeInTheDocument();
    expect(screen.getByText("Basic moderation placeholder")).toBeInTheDocument();
  });

  it("renders selected stars and typed feedback", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));
    fireEvent.change(screen.getByLabelText("Feedback"), {
      target: { value: "Clear, exam-ready explanations." },
    });

    expect(screen.getByRole("radio", { name: "4 stars" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Feedback")).toHaveValue("Clear, exam-ready explanations.");
  });

  it("shows accessible validation errors for invalid submit", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Publish feedback" }));

    expect(screen.getByText("Choose a rating from 1 to 5 stars.")).toBeInTheDocument();
    expect(screen.getByText("Write a short feedback note before publishing.")).toBeInTheDocument();
  });

  it("publishes feedback through the submit handler", async () => {
    const submitFeedback = vi.fn().mockResolvedValue({});
    renderPanel({ submitFeedback });

    fireEvent.click(screen.getByRole("radio", { name: "5 stars" }));
    fireEvent.change(screen.getByLabelText("Feedback"), {
      target: { value: "Excellent notes with useful diagrams and practice prompts." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish feedback" }));

    await waitFor(() => {
      expect(submitFeedback).toHaveBeenCalledWith({
        score: 5,
        comment: "Excellent notes with useful diagrams and practice prompts.",
      });
    });

    expect(screen.getByText("Feedback published and queued for moderation review.")).toBeInTheDocument();
  });

  it("blocks creators from scoring their own resource", () => {
    renderPanel({
      currentAddress: "GCREATOR1234567890",
      creatorAddress: "gcreator1234567890",
    });

    expect(screen.getByText("Creators cannot score their own resource.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish feedback" })).toBeDisabled();
  });

  it("shows existing feedback history and average score", () => {
    renderPanel({
      feedbackData: {
        items: [
          {
            id: "feedback-existing",
            score: 5,
            comment: "Trusted feedback, strong worked examples.",
            reviewerAddress: "GLEARNER123456789",
            moderationStatus: "pending_review",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        averageScore: 5,
        feedbackCount: 1,
      },
    });

    expect(screen.getByText("Trusted feedback, strong worked examples.")).toBeInTheDocument();
    expect(screen.getByText("Queued review")).toBeInTheDocument();
    expect(screen.getByText("1 feedback score")).toBeInTheDocument();
  });
});
