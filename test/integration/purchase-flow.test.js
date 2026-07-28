import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestDb } from "./helpers/mongoFake.js";
import { authCookieHeader } from "./helpers/cookies.js";
import { createSignedCheckoutIntent } from "@/lib/checkout/intent.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-for-integration-tests";

const TEST_CONTRACT_ID = "CTESTPURCHASEMANAGER00000000000000000000000000000000";

let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

// Self-contained so this file's behavior doesn't depend on env mutations
// from sibling test files sharing the same worker process.
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
    this.name = "PurchaseVerificationError";
    this.code = code;
    this.status = status;
  }
}

const verifyPurchaseTransaction = vi.fn();
vi.mock("@/lib/purchases/chainVerifier", () => ({
  verifyPurchaseTransaction: (...args) => verifyPurchaseTransaction(...args),
  PurchaseVerificationError: MockPurchaseVerificationError,
}));

const { POST: PostCheckoutInitiate } = await import("@/app/api/checkout/initiate/route.js");
const { GET: GetPurchases, POST: PostPurchase } = await import("@/app/api/purchase/route.js");

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET";

function cookieFor(address) {
  return authCookieHeader({ sub: `user-${address.slice(0, 6)}`, walletAddress: address });
}

async function seedMaterial({ creatorAddress, price = "10", visibility = "public" }) {
  const result = await db.collection("materials").insertOne({
    title: "Purchasable Notes",
    userAddress: creatorAddress,
    price,
    visibility,
    status: "published",
    storageKey: "bafy-cid",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(result.insertedId);
}

async function initiateCheckout({ cookie, materialId, asset = "USDC" }) {
  const res = await PostCheckoutInitiate(
    new Request("http://localhost/api/checkout/initiate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ materialId, asset }),
    }),
  );
  return res;
}

function submitPurchase({ cookie, body }) {
  return PostPurchase(
    new Request("http://localhost/api/purchase", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

function fakeTxHash(seed = "a") {
  return seed.repeat(64).slice(0, 64);
}

function successfulChainReceipt(overrides = {}) {
  return {
    transactionHash: fakeTxHash(),
    ledger: 12345,
    contractId: TEST_CONTRACT_ID,
    materialId: "unused-by-route",
    buyer: "unused-by-route",
    asset: "USDC",
    amount: "100000000",
    ...overrides,
  };
}

/** Directly inserts an already-signed, already-expired checkout intent (bypassing the initiate route, which always mints a fresh TTL). */
async function insertExpiredIntent({ buyerAddress, materialId, material }) {
  const past = new Date(Date.now() - 60_000);
  const issuedLongAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const signed = createSignedCheckoutIntent({
    buyerAddress,
    materialId,
    material,
    network: STELLAR_NETWORK,
    contractId: TEST_CONTRACT_ID,
    asset: "USDC",
    now: issuedLongAgo,
    expiresAt: past,
  });
  const doc = {
    ...signed,
    materialId,
    buyerAddress: signed.terms.buyer,
    status: "initiated",
    createdAt: issuedLongAgo,
    expiresAt: past,
    consumedAt: null,
    discountCode: null,
    discountPolicy: null,
  };
  const result = await db.collection("checkout_intents").insertOne(doc);
  return String(result.insertedId);
}

describe("purchase flow: happy path", () => {
  beforeEach(() => {
    db = createTestDb({ transactions: true });
    verifyPurchaseTransaction.mockReset();
  });

  it("initiates checkout, completes a purchase, and grants entitlement", async () => {
    const creator = Keypair.random().publicKey();
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: creator });
    const cookie = cookieFor(buyer);

    const initiateRes = await initiateCheckout({ cookie, materialId });
    expect(initiateRes.status).toBe(201);
    const initiated = await initiateRes.json();
    expect(initiated.success).toBe(true);

    const storedIntent = await db.collection("checkout_intents").findOne({});
    expect(storedIntent.status).toBe("initiated");

    const txHash = fakeTxHash("b");
    verifyPurchaseTransaction.mockResolvedValueOnce(successfulChainReceipt({ transactionHash: txHash }));

    const purchaseRes = await submitPurchase({
      cookie,
      body: { materialId, checkoutIntentId: initiated.checkoutId, transactionHash: txHash },
    });
    expect(purchaseRes.status).toBe(201);
    const purchaseData = await purchaseRes.json();
    expect(purchaseData.success).toBe(true);
    expect(purchaseData.access.hasAccess).toBe(true);

    const purchaseDoc = db.dump("purchases")[0];
    expect(purchaseDoc.status).toBe("confirmed");

    const entitlement = db.dump("entitlement_cache")[0];
    expect(entitlement.active).toBe(true);

    const consumedIntent = await db.collection("checkout_intents").findOne({});
    expect(consumedIntent.status).toBe("consumed");

    const outboxEvents = db.dump("outbox");
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0].type).toBe("send_purchase_webhook");

    const listRes = await GetPurchases(new Request("http://localhost/api/purchase", { headers: { cookie } }));
    const list = await listRes.json();
    expect(list).toHaveLength(1);
  });

  it("is idempotent: a retried purchase attempt (fresh intent, buyer already owns the material) returns 200 'Already purchased' instead of double-charging", async () => {
    // Note: replaying with the *same* intent id instead 409s as
    // intent_consumed (loadAndValidateIntent rejects an already-consumed
    // intent before the transaction's own idempotency check ever runs) — the
    // "Already purchased" short-circuit is for a client retrying with a
    // *new* intent after an earlier purchase already completed, e.g. after a
    // dropped response.
    const creator = Keypair.random().publicKey();
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: creator });
    const cookie = cookieFor(buyer);

    const firstIntent = await (await initiateCheckout({ cookie, materialId })).json();
    verifyPurchaseTransaction.mockResolvedValue(successfulChainReceipt({ transactionHash: fakeTxHash("c") }));
    const first = await submitPurchase({ cookie, body: { materialId, checkoutIntentId: firstIntent.checkoutId, transactionHash: fakeTxHash("c") } });
    expect(first.status).toBe(201);

    const secondIntent = await (await initiateCheckout({ cookie, materialId })).json();
    verifyPurchaseTransaction.mockResolvedValue(successfulChainReceipt({ transactionHash: fakeTxHash("cc") }));
    const second = await submitPurchase({ cookie, body: { materialId, checkoutIntentId: secondIntent.checkoutId, transactionHash: fakeTxHash("cc") } });
    expect(second.status).toBe(200);
    const secondData = await second.json();
    expect(secondData.message).toBe("Already purchased");

    expect(db.dump("purchases")).toHaveLength(1);
  });
});

describe("purchase flow: rejected paths", () => {
  beforeEach(() => {
    db = createTestDb({ transactions: true });
    verifyPurchaseTransaction.mockReset();
  });

  it("rejects an unauthenticated purchase attempt with 401", async () => {
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const res = await PostPurchase(
      new Request("http://localhost/api/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ materialId, transactionHash: fakeTxHash() }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a missing transactionHash with 400", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const cookie = cookieFor(buyer);
    const initiated = await (await initiateCheckout({ cookie, materialId })).json();

    const res = await submitPurchase({ cookie, body: { materialId, checkoutIntentId: initiated.checkoutId } });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("missing_transaction_hash");
  });

  it("rejects a signedXdr submitted without a transactionHash (currently 400 missing_transaction_hash — the more specific 422 signed_xdr_only branch is unreachable dead code, since the missing-hash check runs first)", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const cookie = cookieFor(buyer);
    const initiated = await (await initiateCheckout({ cookie, materialId })).json();

    const res = await submitPurchase({
      cookie,
      body: { materialId, checkoutIntentId: initiated.checkoutId, signedXdr: "AAAA...", },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("missing_transaction_hash");
  });

  it("rejects reuse of an already-consumed checkout intent with 409", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const cookie = cookieFor(buyer);
    const initiated = await (await initiateCheckout({ cookie, materialId })).json();

    const intentsCol = db.collection("checkout_intents");
    const stored = await intentsCol.findOne({});
    await intentsCol.updateOne({ _id: stored._id }, { $set: { status: "consumed" } });

    verifyPurchaseTransaction.mockResolvedValue(successfulChainReceipt());
    const res = await submitPurchase({
      cookie,
      body: { materialId, checkoutIntentId: initiated.checkoutId, transactionHash: fakeTxHash("d") },
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe("intent_consumed");
  });

  it("rejects an expired checkout intent with 409", async () => {
    const creator = Keypair.random().publicKey();
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: creator });
    const material = await db.collection("materials").findOne({});
    const intentId = await insertExpiredIntent({ buyerAddress: buyer, materialId, material });
    const cookie = cookieFor(buyer);

    verifyPurchaseTransaction.mockResolvedValue(successfulChainReceipt());
    const res = await submitPurchase({
      cookie,
      body: { materialId, checkoutIntentId: intentId, transactionHash: fakeTxHash("e") },
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe("intent_expired");
  });

  it("rejects a checkout intent belonging to a different buyer with 403", async () => {
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const buyerA = Keypair.random().publicKey();
    const buyerB = Keypair.random().publicKey();
    const initiated = await (await initiateCheckout({ cookie: cookieFor(buyerA), materialId })).json();

    verifyPurchaseTransaction.mockResolvedValue(successfulChainReceipt());
    const res = await submitPurchase({
      cookie: cookieFor(buyerB),
      body: { materialId, checkoutIntentId: initiated.checkoutId, transactionHash: fakeTxHash("f") },
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.code).toBe("wrong_buyer");
  });

  it("surfaces a chain-verification rejection (e.g. amount mismatch) with the mapped status/code", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const cookie = cookieFor(buyer);
    const initiated = await (await initiateCheckout({ cookie, materialId })).json();

    verifyPurchaseTransaction.mockRejectedValueOnce(
      new MockPurchaseVerificationError("wrong_amount", "Purchase amount does not match quote"),
    );

    const res = await submitPurchase({
      cookie,
      body: { materialId, checkoutIntentId: initiated.checkoutId, transactionHash: fakeTxHash("g") },
    });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe("wrong_amount");
    expect(db.dump("purchases")).toHaveLength(0);
    expect(db.dump("entitlement_cache")).toHaveLength(0);
  });

  it("rejects a pending (not-yet-finalized) transaction with 202", async () => {
    const buyer = Keypair.random().publicKey();
    const materialId = await seedMaterial({ creatorAddress: Keypair.random().publicKey() });
    const cookie = cookieFor(buyer);
    const initiated = await (await initiateCheckout({ cookie, materialId })).json();

    verifyPurchaseTransaction.mockRejectedValueOnce(
      new MockPurchaseVerificationError("pending", "Transaction is not finalized", 202),
    );

    const res = await submitPurchase({
      cookie,
      body: { materialId, checkoutIntentId: initiated.checkoutId, transactionHash: fakeTxHash("h") },
    });
    expect(res.status).toBe(202);
  });
});
