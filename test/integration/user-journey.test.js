import { describe, it, expect, beforeAll, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ObjectId } from "mongodb";
import { createTestDb } from "./helpers/mongoFake.js";
import { authCookieHeader } from "./helpers/cookies.js";

/**
 * A single end-to-end walk through the acceptance-criteria journey: wallet
 * profile creation -> material upload/publish -> marketplace browsing ->
 * purchase initiation -> entitlement-validated access — plus one rejected
 * access attempt for a wallet with no entitlement. Individual subsystems
 * (real cookie/JWT mechanics, purchase rejection paths, delivery-token edge
 * cases) have their own dedicated, more exhaustive files; this one is the
 * "does the whole chain actually work together" smoke test.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-for-integration-tests";
const TEST_CONTRACT_ID = "CTESTPURCHASEMANAGER00000000000000000000000000000000";

let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

vi.mock("@/lib/config/chain", () => ({
  PURCHASE_MANAGER_CONTRACT_ID: TEST_CONTRACT_ID,
  MATERIAL_REGISTRY_CONTRACT_ID: "",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URL: "",
  IPFS_GATEWAY_URL: "https://gateway.pinata.cloud",
}));

vi.mock("@/lib/stellar/horizonClient", () => ({
  checkBuyerTrustline: vi.fn(async () => ({ hasTrustline: true })),
}));

class MockPurchaseVerificationError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const verifyPurchaseTransaction = vi.fn();
vi.mock("@/lib/purchases/chainVerifier", () => ({
  verifyPurchaseTransaction: (...args) => verifyPurchaseTransaction(...args),
  PurchaseVerificationError: MockPurchaseVerificationError,
}));

const fakeUpstreamBytes = new TextEncoder().encode("licensed-course-notes-bytes");
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

const { POST: PostProfile } = await import("@/app/api/profile/route.js");
const { POST: PostMaterials } = await import("@/app/api/materials/route.js");
const { POST: PostPublish } = await import("@/app/api/materials/[id]/publish/route.js");
const { GET: GetMarketMaterials } = await import("@/app/api/market-materials/route.js");
const { POST: PostCheckoutInitiate } = await import("@/app/api/checkout/initiate/route.js");
const { GET: GetPurchases, POST: PostPurchase } = await import("@/app/api/purchase/route.js");
const { POST: PostDeliveryToken } = await import("@/app/api/delivery/token/route.js");

const creator = Keypair.random().publicKey();
const buyer = Keypair.random().publicKey();
const outsider = Keypair.random().publicKey();

function cookieFor(address) {
  return authCookieHeader({ sub: `user-${address.slice(0, 6)}`, walletAddress: address });
}

function jsonRequest(url, { method = "GET", cookie, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

let materialId;

describe("full user journey: onboarding -> upload -> browse -> purchase -> gated access", () => {
  beforeAll(() => {
    db = createTestDb({ transactions: true });
  });

  it("1. creator and buyer create wallet profiles", async () => {
    const creatorRes = await PostProfile(
      jsonRequest("http://localhost/api/profile", {
        method: "POST",
        body: { fullName: "Course Creator", email: "creator@journey.test", walletAddress: creator },
      }),
    );
    expect(creatorRes.status).toBe(200);

    const buyerRes = await PostProfile(
      jsonRequest("http://localhost/api/profile", {
        method: "POST",
        body: { fullName: "Course Buyer", email: "buyer@journey.test", walletAddress: buyer },
      }),
    );
    expect(buyerRes.status).toBe(200);
  });

  it("2. creator uploads material metadata and publishes it", async () => {
    const createRes = await PostMaterials(
      jsonRequest("http://localhost/api/materials", {
        method: "POST",
        cookie: cookieFor(creator),
        body: { title: "Advanced Stellar Development", storageKey: "bafy-course-cid", price: 25, visibility: "public" },
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    materialId = String(created.materialId);

    // The delivery layer (getMaterialRecord, src/lib/delivery/stream.js)
    // addresses materials by a `materialId` field rather than Mongo's `_id`;
    // simulate that field being populated (as it would be by the on-chain
    // registration sync) so the entitlement-gated download step resolves.
    await db.collection("materials").updateOne({ _id: new ObjectId(materialId) }, { $set: { materialId, contentType: "application/pdf", fileName: "notes.pdf" } });

    const publishRes = await PostPublish(
      new Request(`http://localhost/api/materials/${materialId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieFor(creator) },
        body: JSON.stringify({}),
      }),
      { params: { id: materialId } },
    );
    expect(publishRes.status).toBe(200);
  });

  it("3. the buyer finds the material via marketplace browsing", async () => {
    const res = await GetMarketMaterials(new Request("http://localhost/api/market-materials"));
    expect(res.status).toBe(200);
    const data = await res.json();
    const listing = data.items.find((item) => item.title === "Advanced Stellar Development");
    expect(listing).toBeTruthy();
    expect(listing.storageKey).toBeUndefined();
  });

  it("4. the buyer initiates checkout", async () => {
    const res = await PostCheckoutInitiate(
      jsonRequest("http://localhost/api/checkout/initiate", { method: "POST", cookie: cookieFor(buyer), body: { materialId, asset: "USDC" } }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.checkoutId).toBeTruthy();
  });

  it("5. the buyer completes the purchase and receives an entitlement", async () => {
    const intentRes = await PostCheckoutInitiate(
      jsonRequest("http://localhost/api/checkout/initiate", { method: "POST", cookie: cookieFor(buyer), body: { materialId, asset: "USDC" } }),
    );
    const intent = await intentRes.json();

    verifyPurchaseTransaction.mockResolvedValueOnce({
      transactionHash: "e".repeat(64),
      ledger: 999,
      contractId: TEST_CONTRACT_ID,
      materialId: "unused-by-route",
      buyer: "unused-by-route",
      asset: "USDC",
      amount: "250000000",
    });

    const purchaseRes = await PostPurchase(
      jsonRequest("http://localhost/api/purchase", {
        method: "POST",
        cookie: cookieFor(buyer),
        body: { materialId, checkoutIntentId: intent.checkoutId, transactionHash: "e".repeat(64) },
      }),
    );
    expect(purchaseRes.status).toBe(201);
    const purchaseData = await purchaseRes.json();
    expect(purchaseData.access.hasAccess).toBe(true);
  });

  it("6. GET /api/purchase lists the buyer's purchase", async () => {
    const res = await GetPurchases(new Request("http://localhost/api/purchase", { headers: { cookie: cookieFor(buyer) } }));
    expect(res.status).toBe(200);
    const purchases = await res.json();
    expect(purchases).toHaveLength(1);
    expect(purchases[0].materialId).toBe(materialId);
  });

  it("7. the buyer's entitlement grants a delivery token", async () => {
    const res = await PostDeliveryToken(
      jsonRequest("http://localhost/api/delivery/token", { method: "POST", cookie: cookieFor(buyer), body: { materialId } }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeTruthy();
  });

  it("8. an uninvolved wallet with no purchase is denied a delivery token", async () => {
    const res = await PostDeliveryToken(
      jsonRequest("http://localhost/api/delivery/token", { method: "POST", cookie: cookieFor(outsider), body: { materialId } }),
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Access denied");
  });
});
