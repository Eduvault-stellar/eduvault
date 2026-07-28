import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Networks, Memo, Operation, Account, TransactionBuilder } from "@stellar/stellar-sdk";
import { createTestDb } from "./helpers/mongoFake.js";
import { authCookieHeader, tamperedAuthCookieHeader, expiredAuthCookieHeader } from "./helpers/cookies.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-for-integration-tests";

/**
 * Deliberately does NOT mock `@/lib/api/auth` (unlike test/setup.js's global
 * convention) so `getUserFromCookie` -> `verifyDashboardToken` run for real
 * against real HMAC-signed JWTs. Only Mongo is faked.
 */
let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

const { GET: GetChallenge } = await import("@/app/api/auth/challenge/route.js");
const { POST: PostVerify } = await import("@/app/api/auth/verify/route.js");
const { POST: PostProfile, GET: GetProfile, PATCH: PatchProfile } = await import("@/app/api/profile/route.js");

function buildSignedTx(keypair, nonce, opts = {}) {
  const source = opts.source || keypair.publicKey();
  const networkPassphrase = opts.networkPassphrase || Networks.TESTNET;
  const account = new Account(source, "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .addMemo(Memo.text(nonce))
    .setTimeout(0)
    .build();
  tx.sign(keypair);
  return tx;
}

function createProfileRequest(body) {
  return new Request("http://localhost/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function extractSetCookie(response, name) {
  const headers = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return headers.find((h) => h.startsWith(`${name}=`)) || null;
}

describe("wallet onboarding: profile create/lookup", () => {
  beforeEach(() => {
    db = createTestDb({ transactions: true });
  });

  it("creates a new profile", async () => {
    const res = await PostProfile(
      createProfileRequest({
        fullName: "Alice Educator",
        email: "alice@example.com",
        walletAddress: Keypair.random().publicKey(),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.user.email).toBe("alice@example.com");
  });

  it("rejects a duplicate profile by email with 409", async () => {
    const email = "dup@example.com";
    const first = await PostProfile(
      createProfileRequest({ fullName: "Person One", email, walletAddress: Keypair.random().publicKey() }),
    );
    expect(first.status).toBe(200);

    const second = await PostProfile(
      createProfileRequest({ fullName: "Person Two", email, walletAddress: Keypair.random().publicKey() }),
    );
    expect(second.status).toBe(409);
  });

  it("GET /api/profile returns exists:false for an unknown wallet", async () => {
    const req = new Request(`http://localhost/api/profile?address=${Keypair.random().publicKey()}`);
    const res = await GetProfile(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ exists: false, user: null });
  });

  it("GET /api/profile returns 400 when address is missing", async () => {
    const res = await GetProfile(new Request("http://localhost/api/profile"));
    expect(res.status).toBe(400);
  });

  it("GET /api/profile finds a user via walletAddressLower when casing differs", async () => {
    const upperCaseWallet = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
    await PostProfile(
      createProfileRequest({ fullName: "Case Test", email: "case@example.com", walletAddress: upperCaseWallet }),
    );

    const res = await GetProfile(new Request(`http://localhost/api/profile?address=${upperCaseWallet.toLowerCase()}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exists).toBe(true);
    expect(data.user.email).toBe("case@example.com");
  });
});

describe("wallet onboarding: real cookie issuance and verification", () => {
  beforeEach(() => {
    db = createTestDb({ transactions: true });
  });

  it("issues auth_token + refresh_token cookies with the expected flags via the real challenge/verify flow", async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    await PostProfile(createProfileRequest({ fullName: "Wallet User", email: "walletuser@example.com", walletAddress: address }));

    const challengeRes = await GetChallenge(new Request(`http://localhost/api/auth/challenge?address=${address}`));
    expect(challengeRes.status).toBe(200);
    const challenge = await challengeRes.json();
    expect(challenge.nonce).toBeTruthy();

    const tx = buildSignedTx(keypair, challenge.nonce);
    const verifyRes = await PostVerify(
      new Request("http://localhost/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, nonce: challenge.nonce, signedTransactionXdr: tx.toXDR() }),
      }),
    );
    expect(verifyRes.status).toBe(200);

    const authCookie = extractSetCookie(verifyRes, "auth_token");
    const refreshCookie = extractSetCookie(verifyRes, "refresh_token");
    expect(authCookie).toBeTruthy();
    expect(refreshCookie).toBeTruthy();
    expect(authCookie).toMatch(/HttpOnly/i);
    expect(authCookie).toMatch(/SameSite=strict/i);
    expect(authCookie).toMatch(/Max-Age=900/);
    expect(refreshCookie).toMatch(/Path=\/api\/auth\/refresh/i);
    expect(refreshCookie).toMatch(/Max-Age=604800/);
  });

  it("rejects replaying the same signed challenge transaction a second time", async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const challengeRes = await GetChallenge(new Request(`http://localhost/api/auth/challenge?address=${address}`));
    const challenge = await challengeRes.json();
    const tx = buildSignedTx(keypair, challenge.nonce);
    const body = JSON.stringify({ address, nonce: challenge.nonce, signedTransactionXdr: tx.toXDR() });

    const first = await PostVerify(new Request("http://localhost/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(first.status).toBe(200);

    const second = await PostVerify(new Request("http://localhost/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(second.status).toBe(401);
  });

  it("real cookie round-trips through PATCH /api/profile (getUserFromCookie -> verifyDashboardToken)", async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    await PostProfile(createProfileRequest({ fullName: "Wallet User", email: "roundtrip@example.com", walletAddress: address }));

    const challengeRes = await GetChallenge(new Request(`http://localhost/api/auth/challenge?address=${address}`));
    const challenge = await challengeRes.json();
    const tx = buildSignedTx(keypair, challenge.nonce);
    const verifyRes = await PostVerify(
      new Request("http://localhost/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, nonce: challenge.nonce, signedTransactionXdr: tx.toXDR() }),
      }),
    );
    const authCookie = extractSetCookie(verifyRes, "auth_token");
    const cookieValue = authCookie.split(";")[0];

    const patchRes = await PatchProfile(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: cookieValue },
        body: JSON.stringify({ bio: "Updated bio via real cookie" }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const data = await patchRes.json();
    expect(data.user.bio).toBe("Updated bio via real cookie");
  });

  it("PATCH /api/profile rejects a wallet-address mismatch between the session and the payload with 403", async () => {
    const cookie = authCookieHeader({ sub: "user123", walletAddress: Keypair.random().publicKey() });
    const res = await PatchProfile(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ walletAddress: Keypair.random().publicKey() }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("PATCH /api/profile rejects a tampered cookie signature with 401", async () => {
    const cookie = tamperedAuthCookieHeader({ sub: "user123", walletAddress: Keypair.random().publicKey() });
    const res = await PatchProfile(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ bio: "should not apply" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /api/profile rejects an expired cookie with 401", async () => {
    const cookie = expiredAuthCookieHeader({ sub: "user123", walletAddress: Keypair.random().publicKey() });
    const res = await PatchProfile(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ bio: "should not apply" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /api/profile rejects a missing cookie with 401", async () => {
    const res = await PatchProfile(
      new Request("http://localhost/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bio: "no cookie" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
