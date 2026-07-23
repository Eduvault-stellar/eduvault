import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestDb } from "./helpers/mongoFake.js";
import { authCookieHeader } from "./helpers/cookies.js";
import { createEntitlement } from "@/lib/entitlement.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-for-integration-tests";

let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

// Forces `checkChainEntitlement` (src/lib/entitlement.js) to short-circuit to
// null instead of attempting a real network call, regardless of what other
// integration test files in this worker may have set on process.env.
vi.mock("@/lib/config/chain", () => ({
  PURCHASE_MANAGER_CONTRACT_ID: "",
  MATERIAL_REGISTRY_CONTRACT_ID: "",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URL: "",
  IPFS_GATEWAY_URL: "https://gateway.pinata.cloud",
}));

const fakeUpstreamBytes = new TextEncoder().encode("fake-protected-file-bytes");
vi.mock("@/lib/delivery/stream", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createUpstreamStream: vi.fn(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(fakeUpstreamBytes);
            controller.close();
          },
        }),
    ),
  };
});

const { POST: PostDeliveryToken } = await import("@/app/api/delivery/token/route.js");
const { GET: GetDeliveryStream } = await import("@/app/api/delivery/stream/route.js");

function cookieFor(address) {
  return authCookieHeader({ sub: `user-${address.slice(0, 6)}`, walletAddress: address });
}

async function seedMaterial(materialId, overrides = {}) {
  await db.collection("materials").insertOne({
    materialId,
    title: "Protected Material",
    cid: "bafy-protected-cid",
    contentType: "application/pdf",
    fileName: "protected.pdf",
    fileSize: fakeUpstreamBytes.length,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function requestToken({ cookie, materialId, ttlSeconds }) {
  return PostDeliveryToken(
    new Request("http://localhost/api/delivery/token", {
      method: "POST",
      headers: cookie ? { "content-type": "application/json", cookie } : { "content-type": "application/json" },
      body: JSON.stringify({ materialId, ...(ttlSeconds ? { ttlSeconds } : {}) }),
    }),
  );
}

function requestStream({ token, materialId }) {
  const params = new URLSearchParams();
  if (token !== undefined) params.set("token", token);
  if (materialId !== undefined) params.set("materialId", materialId);
  return GetDeliveryStream(new Request(`http://localhost/api/delivery/stream?${params.toString()}`));
}

describe("entitlement gating: POST /api/delivery/token", () => {
  beforeEach(() => {
    db = createTestDb();
  });

  it("issues a token for a buyer with an active entitlement, without leaking the CID/gateway URL", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    await seedMaterial(materialId);
    await createEntitlement(materialId, buyer, { purchaseId: "p1", transactionHash: "tx1" });

    const res = await requestToken({ cookie: cookieFor(buyer), materialId });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.token).toBeTruthy();
    expect(data).not.toHaveProperty("cid");
    expect(data).not.toHaveProperty("gatewayUrl");
    expect(JSON.stringify(data)).not.toContain("bafy-protected-cid");
  });

  it("rejects a buyer with no entitlement with 403", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    await seedMaterial(materialId);

    const res = await requestToken({ cookie: cookieFor(buyer), materialId });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Access denied");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const materialId = crypto.randomUUID();
    await seedMaterial(materialId);
    const res = await requestToken({ materialId });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the entitlement exists but the material record does not", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    await createEntitlement(materialId, buyer, { purchaseId: "p2", transactionHash: "tx2" });

    const res = await requestToken({ cookie: cookieFor(buyer), materialId });
    expect(res.status).toBe(404);
  });
});

describe("entitlement gating: GET /api/delivery/stream", () => {
  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams file bytes for a valid token and sets hardened headers", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    await seedMaterial(materialId);
    await createEntitlement(materialId, buyer, { purchaseId: "p3", transactionHash: "tx3" });

    const tokenRes = await requestToken({ cookie: cookieFor(buyer), materialId });
    const { token } = await tokenRes.json();

    const streamRes = await requestStream({ token, materialId });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("cache-control")).toMatch(/no-store/);
    expect(streamRes.headers.get("x-content-type-options")).toBe("nosniff");
    const bodyText = await streamRes.text();
    expect(bodyText).toBe("fake-protected-file-bytes");
  });

  it("rejects a token scoped to a different material with 401", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    const otherMaterialId = crypto.randomUUID();
    await seedMaterial(materialId);
    await createEntitlement(materialId, buyer, { purchaseId: "p4", transactionHash: "tx4" });

    const tokenRes = await requestToken({ cookie: cookieFor(buyer), materialId });
    const { token } = await tokenRes.json();

    const streamRes = await requestStream({ token, materialId: otherMaterialId });
    expect(streamRes.status).toBe(401);
  });

  it("rejects a tampered token with 401", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    await seedMaterial(materialId);
    await createEntitlement(materialId, buyer, { purchaseId: "p5", transactionHash: "tx5" });

    const tokenRes = await requestToken({ cookie: cookieFor(buyer), materialId });
    const { token } = await tokenRes.json();
    const tampered = `${token.slice(0, -2)}zz`;

    const streamRes = await requestStream({ token: tampered, materialId });
    expect(streamRes.status).toBe(401);
  });

  it("rejects an expired token with 410", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = crypto.randomUUID();
    await seedMaterial(materialId);
    await createEntitlement(materialId, buyer, { purchaseId: "p6", transactionHash: "tx6" });

    const tokenRes = await requestToken({ cookie: cookieFor(buyer), materialId, ttlSeconds: 1 });
    const { token } = await tokenRes.json();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);

    const streamRes = await requestStream({ token, materialId });
    expect(streamRes.status).toBe(410);
  });

  it("rejects a request missing token/materialId with 400", async () => {
    const res = await requestStream({});
    expect(res.status).toBe(400);
  });
});
