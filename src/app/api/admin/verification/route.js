import { NextResponse } from "next/server";
import { withAuthorization } from "@/lib/auth/authorize";
import { isAdmin } from "@/lib/auth/policies";
import {
  reviewStudentVerification,
  listPendingApplications,
  getDecryptedDocumentForReview,
  VerificationLifecycleError,
  statusToHttp,
} from "@/lib/verification/studentVerificationLifecycle";

/**
 * POST /api/admin/verification
 * Approve or reject a pending student verification application.
 *
 * Body: { applicationId, action: "approve" | "reject", reviewNotes? }
 * Optional: { applicationId, action: "view" } decrypts the document for
 * review without changing its status (still requires it be pending and
 * inside its review window — see #165).
 */
export const POST = withAuthorization(
  async (request) => {
    const { userId } = request;

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const { applicationId, action, reviewNotes } = body || {};

    if (!applicationId) {
      return NextResponse.json({ error: "applicationId is required" }, { status: 400 });
    }

    try {
      if (action === "view") {
        const document = await getDecryptedDocumentForReview(applicationId);
        return NextResponse.json({
          success: true,
          filename: document.filename,
          mimetype: document.mimetype,
          // Base64 so the JSON response can carry binary bytes; decrypted
          // in-memory only for this request, never re-persisted.
          data: document.buffer.toString("base64"),
        });
      }

      if (!["approve", "reject"].includes(action)) {
        return NextResponse.json(
          { error: "action must be one of: approve, reject, view" },
          { status: 400 }
        );
      }

      const updated = await reviewStudentVerification({
        applicationId,
        actorId: userId,
        action,
        reviewNotes: reviewNotes || null,
      });

      return NextResponse.json({ success: true, status: updated.status });
    } catch (error) {
      if (error instanceof VerificationLifecycleError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: statusToHttp(error.code) }
        );
      }
      console.error("[admin/verification] POST error:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
  {
    checkOwnership: async (userId, fullUser) => isAdmin(fullUser),
  }
);

/**
 * GET /api/admin/verification
 * Lists pending student verification applications awaiting review.
 * Never includes the encrypted document payload; applications whose review
 * window has elapsed are lazily expired (and excluded) before listing.
 */
export const GET = withAuthorization(
  async () => {
    try {
      const applications = await listPendingApplications();
      return NextResponse.json({
        success: true,
        applications: applications.map((application) => ({
          ...application,
          _id: application._id.toString(),
        })),
      });
    } catch (error) {
      console.error("[admin/verification] GET error:", error);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
  },
  {
    checkOwnership: async (userId, fullUser) => isAdmin(fullUser),
  }
);
