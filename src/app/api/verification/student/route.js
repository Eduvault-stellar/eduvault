import { NextResponse } from "next/server";
import { validateAuth } from "@/lib/auth/session";
import { withApiHardening } from "@/lib/api/hardening";
import {
  submitStudentVerification,
  getVerificationStatusForWallet,
  VerificationLifecycleError,
  statusToHttp,
} from "@/lib/verification/studentVerificationLifecycle";

/**
 * POST /api/verification/student
 * Submit student verification application with documents.
 *
 * The uploaded document is AES-256-GCM encrypted before it is persisted
 * (src/lib/security/documentCipher.js) and carries an expiring review
 * window (src/lib/verification/studentVerificationLifecycle.js) — see #165.
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "verification-student", rateLimit: { limit: 5, windowMs: 60 * 60_000 } },
    async () => submitStudentVerificationHandler(request)
  );
}

async function submitStudentVerificationHandler(request) {
  const authResult = await validateAuth(request);
  if (!authResult.valid) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const authenticatedAddress = String(authResult.address).toLowerCase();

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart/form-data payload" }, { status: 400 });
  }

  const walletAddress = formData.get("walletAddress");
  if (!walletAddress || String(walletAddress).toLowerCase() !== authenticatedAddress) {
    return NextResponse.json(
      { error: "Forbidden: walletAddress must match the authenticated session" },
      { status: 403 }
    );
  }

  const fullName = formData.get("fullName");
  const email = formData.get("email");
  const institution = formData.get("institution");
  const studentId = formData.get("studentId");
  const expectedGraduation = formData.get("expectedGraduation");
  const document = formData.get("document");

  if (!fullName || !email || !institution || !studentId || !expectedGraduation || !document) {
    return NextResponse.json({ error: "All fields are required" }, { status: 400 });
  }

  let documentBuffer;
  try {
    const bytes = await document.arrayBuffer();
    documentBuffer = Buffer.from(bytes);
  } catch {
    return NextResponse.json({ error: "Failed to read uploaded document" }, { status: 400 });
  }

  try {
    const verification = await submitStudentVerification({
      walletAddress: authenticatedAddress,
      fullName,
      email,
      institution,
      studentId,
      expectedGraduation,
      documentBuffer,
      documentFilename: document.name,
      documentMimeType: document.type,
      documentSize: document.size,
    });

    return NextResponse.json(
      {
        success: true,
        verificationId: verification._id.toString(),
        message: "Verification application submitted successfully",
        status: verification.status,
        documentExpiresAt: verification.documentExpiresAt,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof VerificationLifecycleError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: statusToHttp(error.code) });
    }
    console.error("[verification/student] POST error:", error);
    return NextResponse.json({ error: "Failed to submit verification application" }, { status: 500 });
  }
}

/**
 * GET /api/verification/student
 * Check student verification status for the authenticated user. Never
 * returns the encrypted document payload; a pending application whose
 * review window has elapsed is reported (and lazily transitioned) as
 * "expired" rather than staying silently stuck at "pending".
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "verification-student", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => getStudentVerificationStatusHandler(request)
  );
}

async function getStudentVerificationStatusHandler(request) {
  const authResult = await validateAuth(request);
  if (!authResult.valid) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const verification = await getVerificationStatusForWallet(authResult.address);

    if (!verification) {
      return NextResponse.json({ success: true, verified: false, status: "not_applied" });
    }

    return NextResponse.json({
      success: true,
      verified: verification.status === "approved",
      status: verification.status,
      verification: {
        ...verification,
        _id: verification._id.toString(),
      },
    });
  } catch (error) {
    console.error("[verification/student] GET error:", error);
    return NextResponse.json(
      { error: "Failed to check verification status", details: error.message },
      { status: 500 }
    );
  }
}
