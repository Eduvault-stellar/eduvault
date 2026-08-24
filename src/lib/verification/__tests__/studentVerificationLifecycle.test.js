/**
 * Race-safety / concurrency tests for the student verification lifecycle.
 *
 * Exercises issue #107 acceptance criteria:
 *   - "A concurrency test with parallel requests yields exactly one
 *      successful create/approval."
 *   - "Losing requests receive a stable typed 409, not a generic 500."
 *   - "Approval side effects commit or roll back as one transaction."
 *
 * fakeMongo (../../../../tests/backend/helpers/fakeMongo.mjs) already
 * enforces the partial unique index we declared in schemaContracts, and
 * throws MongoDB-style E11000 on clash — so we can prove the lifecycle
 * correctly maps E11000 → typed 409 without spinning up a real Mongo.
 *
 * `auditLog` is mocked so the tests run without a logger destination, and
 * `getDb()` is mocked to return our `fakeDb` instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Set the encryption key BEFORE importing the lifecycle, since
// documentCipher validates the env var at module load time.
process.env.VERIFICATION_DOCUMENT_KEY = randomBytes(32).toString("hex");
process.env.VERIFICATION_ACCEPTING_APPLICATIONS = "true";

vi.mock("@/lib/api/audit", () => ({ auditLog: vi.fn() }));

let fakeDb;

vi.mock("@/lib/mongodb", () => ({
  getDb: vi.fn(async () => fakeDb),
}));

import { createFakeDb } from "../../../../tests/backend/helpers/fakeMongo.mjs";

const {
  submitStudentVerification,
  reviewStudentVerification,
  expireStaleSubmissions,
  getVerificationStatusForWallet,
  listPendingApplications,
  getDecryptedDocumentForReview,
  VERIFICATION_STATUS,
  VerificationLifecycleError,
  statusToHttp,
  LIFECYCLE_ERROR_HTTP_STATUS,
  isVerificationAcceptingApplications,
} = await import("../studentVerificationLifecycle.js");

function validInput(overrides = {}) {
  const buffer = Buffer.from(`pdf-${Math.random()}`);
  return {
    walletAddress: "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    institution: "EduVault Institute",
    studentId: "S12345",
    expectedGraduation: "2027-06-01",
    documentBuffer: buffer,
    documentFilename: "transcript.pdf",
    documentMimeType: "application/pdf",
    documentSize: buffer.length,
    ...overrides,
  };
}

describe("LIFECYCLE_ERROR_HTTP_STATUS — #107 typed 409 contract", () => {
  it("every conflict-relevant code maps to HTTP 409", () => {
    expect(LIFECYCLE_ERROR_HTTP_STATUS.duplicate_submission).toBe(409);
    expect(LIFECYCLE_ERROR_HTTP_STATUS.invalid_transition).toBe(409);
    expect(LIFECYCLE_ERROR_HTTP_STATUS.conflict).toBe(409);
    expect(LIFECYCLE_ERROR_HTTP_STATUS.channel_unavailable).toBe(409);
  });

  it("statusToHttp() returns the typed status for known codes", () => {
    expect(statusToHttp("duplicate_submission")).toBe(409);
    expect(statusToHttp("conflict")).toBe(409);
    expect(statusToHttp("invalid_transition")).toBe(409);
    expect(statusToHttp("channel_unavailable")).toBe(409);
    expect(statusToHttp("expired")).toBe(410);
    expect(statusToHttp("not_found")).toBe(404);
    expect(statusToHttp("forbidden")).toBe(403);
    expect(statusToHttp("invalid_input")).toBe(400);
    expect(statusToHttp("encryption_unavailable")).toBe(503);
  });

  it("statusToHttp() falls back to 500 only for unknown codes", () => {
    expect(statusToHttp("not_a_real_code")).toBe(500);
  });

  it("isVerificationAcceptingApplications defaults to true when env unset", () => {
    expect(isVerificationAcceptingApplications({})).toBe(true);
    expect(isVerificationAcceptingApplications({ VERIFICATION_ACCEPTING_APPLICATIONS: "" })).toBe(true);
  });

  it("isVerificationAcceptingApplications honours an explicit false flag", () => {
    expect(isVerificationAcceptingApplications({ VERIFICATION_ACCEPTING_APPLICATIONS: "false" })).toBe(false);
    expect(isVerificationAcceptingApplications({ VERIFICATION_ACCEPTING_APPLICATIONS: "0" })).toBe(false);
    expect(isVerificationAcceptingApplications({ VERIFICATION_ACCEPTING_APPLICATIONS: "off" })).toBe(false);
  });
});

describe("submitStudentVerification — create race-safety (#107)", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("20 concurrent submissions for the same wallet yield exactly one success", async () => {
    const wallet = "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const submissions = Array.from({ length: 20 }, () =>
      submitStudentVerification({ ...validInput({ walletAddress: wallet }), db: fakeDb }),
    );

    const results = await Promise.allSettled(submissions);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);

    for (const rejection of rejected) {
      expect(rejection.reason).toBeInstanceOf(VerificationLifecycleError);
      expect(rejection.reason.code).toBe("duplicate_submission");
      // #107 acceptance: losing requests get a typed 409, never a 500.
      expect(statusToHttp(rejection.reason.code)).toBe(409);
    }

    const stored = fakeDb.dump("student_verifications");
    expect(stored).toHaveLength(1);
    expect(stored[0].walletAddress).toBe(wallet.toLowerCase());
    expect(stored[0].status).toBe(VERIFICATION_STATUS.PENDING);
  });

  it("a sequential second submission is rejected with duplicate_submission", async () => {
    const input = validInput();
    const first = await submitStudentVerification({ ...input, db: fakeDb });
    expect(first.status).toBe(VERIFICATION_STATUS.PENDING);

    await expect(
      submitStudentVerification({ ...input, db: fakeDb }),
    ).rejects.toMatchObject({
      name: "VerificationLifecycleError",
      code: "duplicate_submission",
    });
  });

  it("a rejected application frees the wallet for a fresh submission", async () => {
    const input = validInput();
    const first = await submitStudentVerification({ ...input, db: fakeDb });
    await reviewStudentVerification({
      applicationId: first._id,
      actorId: "admin-1",
      action: "reject",
      db: fakeDb,
    });

    const second = await submitStudentVerification({ ...input, db: fakeDb });
    expect(second.status).toBe(VERIFICATION_STATUS.PENDING);
    expect(String(second._id)).not.toBe(String(first._id));
  });

  it("an approved application blocks further submissions on the same wallet", async () => {
    const input = validInput();
    const first = await submitStudentVerification({ ...input, db: fakeDb });
    await reviewStudentVerification({
      applicationId: first._id,
      actorId: "admin-1",
      action: "approve",
      db: fakeDb,
    });

    await expect(
      submitStudentVerification({ ...input, db: fakeDb }),
    ).rejects.toMatchObject({ code: "duplicate_submission" });
  });

  it("rejects with channel_unavailable when the channel is closed", async () => {
    const input = validInput({
      env: { VERIFICATION_ACCEPTING_APPLICATIONS: "false" },
    });
    await expect(
      submitStudentVerification({ ...input, db: fakeDb }),
    ).rejects.toMatchObject({
      code: "channel_unavailable",
    });
    expect(statusToHttp("channel_unavailable")).toBe(409);
    expect(fakeDb.dump("student_verifications")).toHaveLength(0);
  });
});

describe("reviewStudentVerification — approval race-safety (#107)", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("20 concurrent approvals for the same application yield exactly one success", async () => {
    const submitted = await submitStudentVerification({ ...validInput(), db: fakeDb });

    const attempts = Array.from({ length: 20 }, (_, index) =>
      reviewStudentVerification({
        applicationId: submitted._id,
        actorId: `admin-${index}`,
        action: index % 2 === 0 ? "approve" : "reject",
        db: fakeDb,
      }),
    );

    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);

    for (const rejection of rejected) {
      expect(rejection.reason).toBeInstanceOf(VerificationLifecycleError);
      // The losing reviewers either hit the typed `conflict` 409 (someone
      // beat them to the update) or `invalid_transition` if their read
      // arrived after the winner's commit. Both are typed 409s.
      expect(["conflict", "invalid_transition"]).toContain(rejection.reason.code);
      expect(statusToHttp(rejection.reason.code)).toBe(409);
    }

    const stored = fakeDb.dump("student_verifications");
    expect(stored).toHaveLength(1);
    expect([VERIFICATION_STATUS.APPROVED, VERIFICATION_STATUS.REJECTED]).toContain(
      stored[0].status,
    );
    // Encrypted payload must be purged on the winning decision.
    expect(stored[0].document?.encrypted).toBeUndefined();
  });

  it("approving twice sequentially throws a typed 409 on the second call", async () => {
    const submitted = await submitStudentVerification({ ...validInput(), db: fakeDb });
    const winner = await reviewStudentVerification({
      applicationId: submitted._id,
      actorId: "admin-1",
      action: "approve",
      db: fakeDb,
    });
    expect(winner.status).toBe(VERIFICATION_STATUS.APPROVED);

    await expect(
      reviewStudentVerification({
        applicationId: submitted._id,
        actorId: "admin-2",
        action: "approve",
        db: fakeDb,
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
    });
    expect(statusToHttp("invalid_transition")).toBe(409);
  });

  it("rejecting a non-existent application raises typed not_found", async () => {
    await expect(
      reviewStudentVerification({
        applicationId: "ghost-id",
        actorId: "admin-1",
        action: "reject",
        db: fakeDb,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("getDecryptedDocumentForReview + expireStaleSubmissions", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("encrypted payload survives the submission and is purged on approval", async () => {
    const submitted = await submitStudentVerification({ ...validInput(), db: fakeDb });
    const doc = await getDecryptedDocumentForReview(submitted._id, { db: fakeDb });
    expect(doc.filename).toBe("transcript.pdf");
    expect(doc.mimetype).toBe("application/pdf");

    await reviewStudentVerification({
      applicationId: submitted._id,
      actorId: "admin-1",
      action: "approve",
      db: fakeDb,
    });

    await expect(
      getDecryptedDocumentForReview(submitted._id, { db: fakeDb }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("expireStaleSubmissions marks pending records past their window as expired", async () => {
    const submitted = await submitStudentVerification({ ...validInput(), db: fakeDb });

    const fifteenDaysFromNow = new Date(
      submitted.submittedAt.getTime() + 15 * 24 * 60 * 60 * 1000,
    );
    const result = await expireStaleSubmissions({ now: fifteenDaysFromNow, db: fakeDb });
    expect(result.expiredCount).toBe(1);

    const stored = fakeDb.dump("student_verifications");
    expect(stored[0].status).toBe(VERIFICATION_STATUS.EXPIRED);
  });
});

describe("getVerificationStatusForWallet — read after expiry lazy-transition", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("a stale pending application is reported as expired to the caller", async () => {
    const submitted = await submitStudentVerification({ ...validInput(), db: fakeDb });

    // Call with a `now` that is beyond the 14-day review window so the
    // stored documentExpiresAt is already in the past. This is more robust
    // than mutating the stored document directly because fakeMongo.dump()
    // returns shallow copies.
    const fifteenDaysFromNow = new Date(
      submitted.submittedAt.getTime() + 15 * 24 * 60 * 60 * 1000,
    );

    const status = await getVerificationStatusForWallet(submitted.walletAddress, {
      now: fifteenDaysFromNow,
      db: fakeDb,
    });
    expect(status.status).toBe(VERIFICATION_STATUS.EXPIRED);

    const stored = fakeDb.dump("student_verifications");
    expect(stored[0].status).toBe(VERIFICATION_STATUS.EXPIRED);
  });
});

describe("listPendingApplications — admin queue", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
  });

  it("returns only pending rows, newest first", async () => {
    const a = await submitStudentVerification({
      ...validInput({ walletAddress: "GWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      db: fakeDb,
    });
    // Force a distinct submittedAt for deterministic ordering.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await submitStudentVerification({
      ...validInput({ walletAddress: "GWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }),
      db: fakeDb,
    });

    await reviewStudentVerification({
      applicationId: a._id,
      actorId: "admin-1",
      action: "approve",
      db: fakeDb,
    });

    const pending = await listPendingApplications({ db: fakeDb });
    expect(pending).toHaveLength(1);
    expect(String(pending[0]._id)).toBe(String(b._id));
  });
});
