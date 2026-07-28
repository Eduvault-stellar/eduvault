import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestDb } from "../helpers/mongoFake.js";
import { authCookieHeader } from "../helpers/cookies.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret";

let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

// Import the API handlers
const { POST: PostVerify } = await import("@/app/api/auth/verify/route.js");
const { GET: GetBootstrap } = await import("@/app/api/auth/bootstrap/route.js");
const { POST: PostRole } = await import("@/app/api/auth/onboarding/role/route.js");

// Helper to build signed transaction
function buildSignedTx(keypair, nonce) {
  return {
    toXDR: () => `test-xdr-for-${nonce}`,
  };
}

describe("Onboarding: Role Provisioning", () => {
  let keypair;
  let walletAddress;
  let authHeaders;

  beforeEach(async () => {
    db = await createTestDb();
    keypair = Keypair.random();
    walletAddress = keypair.publicKey();
    
    // Create a user first (mimic auth verification)
    const nonce = "test-nonce-123";
    const tx = buildSignedTx(keypair, nonce);
    
    const verifyReq = new Request("http://localhost/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: walletAddress,
        nonce: nonce,
        signedTransactionXdr: tx.toXDR(),
      }),
    });
    
    const verifyRes = await PostVerify(verifyReq);
    const setCookie = verifyRes.headers.getSetCookie();
    authHeaders = {
      cookie: setCookie.join("; "),
    };
  });

  // Test 1: Successful role provisioning
  it("should provision a role atomically", async () => {
    const roleReq = new Request("http://localhost/api/auth/onboarding/role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({
        role: "grantee",
        roleData: {
          organization: "Test Org",
          description: "Test description",
        },
      }),
    });

    const roleRes = await PostRole(roleReq);
    const data = await roleRes.json();

    expect(roleRes.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.user.role).toBe("grantee");
    expect(data.onboarding.state).toBe("provisioned");

    // Verify onboarding state in DB
    const onboarding = await db.collection("onboarding").findOne({ userId: data.user.id });
    expect(onboarding.state).toBe("provisioned");
    expect(onboarding.selectedRole).toBe("grantee");

    // Verify user role in DB
    const user = await db.collection("users").findOne({ uuid: data.user.id });
    expect(user.role).toBe("grantee");
  });

  // Test 2: Cannot change role after provisioning
  it("should prevent role changes after provisioning", async () => {
    // First, provision a role
    const roleReq = new Request("http://localhost/api/auth/onboarding/role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ role: "grantee" }),
    });
    await PostRole(roleReq);

    // Try to change role
    const changeReq = new Request("http://localhost/api/auth/onboarding/role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ role: "admin" }),
    });

    const changeRes = await PostRole(changeReq);
    const data = await changeRes.json();

    expect(changeRes.status).toBe(400);
    expect(data.error).toContain("already provisioned");
  });

  // Test 3: Disabled user cannot provision role
  it("should prevent role provisioning for disabled users", async () => {
    // Disable the user
    await db.collection("users").updateOne(
      { walletAddress: walletAddress },
      { $set: { status: "disabled" } }
    );

    const roleReq = new Request("http://localhost/api/auth/onboarding/role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ role: "grantee" }),
    });

    const roleRes = await PostRole(roleReq);
    expect(roleRes.status).toBe(403);
  });

  // Test 4: Invalid role is rejected
  it("should reject invalid roles", async () => {
    const roleReq = new Request("http://localhost/api/auth/onboarding/role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ role: "invalid-role" }),
    });

    const roleRes = await PostRole(roleReq);
    expect(roleRes.status).toBe(400);
  });

  // Test 5: Concurrent role selection (idempotency)
  it("should handle concurrent role selection gracefully", async () => {
    // Simulate concurrent requests
    const requests = Array(3).fill().map(() => 
      new Request("http://localhost/api/auth/onboarding/role", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({ role: "grantee" }),
      })
    );

    const responses = await Promise.all(requests.map(req => PostRole(req)));
    const results = await Promise.all(responses.map(res => res.json()));

    // All should succeed or only one succeeds and others get appropriate response
    const successes = results.filter(r => r.success === true);
    expect(successes.length).toBeGreaterThan(0);
    
    // Verify only one user exists
    const users = await db.collection("users").find({ walletAddress: walletAddress }).toArray();
    expect(users.length).toBe(1);
  });

  // Test 6: Bootstrap endpoint returns correct state
  it("should return correct onboarding state from bootstrap endpoint", async () => {
    // First, provision a role
    const roleReq = new Request("http://localhost/api/auth/onboarding/role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ role: "payoutProvider" }),
    });
    await PostRole(roleReq);

    // Call bootstrap
    const bootstrapReq = new Request("http://localhost/api/auth/bootstrap", {
      headers: authHeaders,
    });
    const bootstrapRes = await GetBootstrap(bootstrapReq);
    const data = await bootstrapRes.json();

    expect(data.authenticated).toBe(true);
    expect(data.user.role).toBe("payoutProvider");
    expect(data.onboarding.state).toBe("provisioned");
    expect(data.onboarding.selectedRole).toBe("payoutProvider");
  });
});
