import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createTestDb } from "./helpers/mongoFake.js";
import { authCookieHeader } from "./helpers/cookies.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-jwt-secret-for-integration-tests";

let db;
vi.mock("@/lib/mongodb", () => ({
  getDb: async () => db,
  getMongoClientPromise: async () => db.client,
}));

const pinataMock = {
  upload: {
    public: {
      file: vi.fn(async (file) => ({ cid: `bafy-fake-cid-${file.name || "file"}` })),
      json: vi.fn(async () => ({ cid: "bafy-fake-metadata-cid" })),
    },
  },
  gateways: {
    public: {
      convert: vi.fn(async (cid) => `https://gateway.pinata.cloud/ipfs/${cid}`),
    },
  },
};
vi.mock("@/lib/pinata", () => ({ pinata: pinataMock }));

const { POST: PostMaterials } = await import("@/app/api/materials/route.js");
const { POST: PostPublish } = await import("@/app/api/materials/[id]/publish/route.js");
const { POST: PostUpload } = await import("@/app/api/materials/upload/route.js");
const { GET: GetMarketMaterials } = await import("@/app/api/market-materials/route.js");

function pdfFile(name = "notes.pdf") {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
  return new File([bytes], name, { type: "application/pdf" });
}

/**
 * jsdom's Request/FormData/File round-trip (`new Request(url, { body: form
 * })` -> `request.formData()`) does not faithfully preserve binary File
 * content in this environment — it comes back as the literal string
 * "undefined" instead of the original bytes. Since the vitest environment is
 * globally set to "jsdom" (for component tests) and route handlers only
 * need `request.formData()` to resolve to the FormData we built, construct a
 * real Request for headers/method and stub just `.formData()` to hand back
 * that FormData directly, sidestepping the broken (re-)serialization.
 */
function uploadRequest(form) {
  const req = new Request("http://localhost/api/materials/upload", { method: "POST" });
  req.formData = async () => form;
  return req;
}

function creatorCookie(address) {
  return authCookieHeader({ sub: "creator-1", walletAddress: address });
}

async function createMaterial({ cookie, title = "Intro to Testing", price = 10, visibility = "private" }) {
  return PostMaterials(
    new Request("http://localhost/api/materials", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title, storageKey: "bafy-existing-cid", price, visibility }),
    }),
  );
}

describe("material upload", () => {
  beforeEach(() => {
    db = createTestDb();
    pinataMock.upload.public.file.mockClear();
    pinataMock.upload.public.json.mockClear();
  });

  it("rejects a request with no file", async () => {
    const form = new FormData();
    const res = await PostUpload(uploadRequest(form));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized file", async () => {
    const form = new FormData();
    const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.pdf", { type: "application/pdf" });
    form.set("file", big);
    const res = await PostUpload(uploadRequest(form));
    expect(res.status).toBe(413);
  });

  it("rejects an unsupported MIME type", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "notes.exe", { type: "application/x-msdownload" }));
    const res = await PostUpload(uploadRequest(form));
    expect(res.status).toBe(415);
  });

  it("blocks a spoofed MIME type via magic-number validation", async () => {
    const form = new FormData();
    // Declares application/pdf but the bytes don't start with %PDF.
    form.set("file", new File([new Uint8Array([0, 0, 0, 0])], "fake.pdf", { type: "application/pdf" }));
    form.set("title", "Spoofed file");
    const res = await PostUpload(uploadRequest(form));
    expect(res.status).toBe(422);
  });

  it("uploads a valid file to Pinata and returns storageKey/metadata without writing to Mongo", async () => {
    const form = new FormData();
    form.set("file", pdfFile());
    form.set("title", "Valid Upload");
    form.set("price", "5");
    form.set("visibility", "public");

    const res = await PostUpload(uploadRequest(form));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.storageKey).toBe("bafy-fake-cid-notes.pdf");
    expect(data.metadata).toBe("https://gateway.pinata.cloud/ipfs/bafy-fake-metadata-cid");
    expect(pinataMock.upload.public.file).toHaveBeenCalledTimes(1);
    expect(db.dump("materials")).toHaveLength(0);
  });
});

describe("material create + publish", () => {
  beforeEach(() => {
    db = createTestDb();
  });

  it("creates a material and publishes it as the owner", async () => {
    const owner = Keypair.random().publicKey();
    const cookie = creatorCookie(owner);

    const createRes = await createMaterial({ cookie, visibility: "public" });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.materialId).toBeTruthy();
    expect(created.storageKey).toBeUndefined(); // sanitizeMaterial strips it from the response

    const publishRes = await PostPublish(
      new Request(`http://localhost/api/materials/${created.materialId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({}),
      }),
      { params: { id: String(created.materialId) } },
    );
    expect(publishRes.status).toBe(200);
    const published = await publishRes.json();
    expect(published.success).toBe(true);
    expect(published.status).toBe("published");
  });

  it("rejects publish from a non-owner with 403", async () => {
    const owner = Keypair.random().publicKey();
    const intruder = Keypair.random().publicKey();
    const createRes = await createMaterial({ cookie: creatorCookie(owner) });
    const created = await createRes.json();

    const publishRes = await PostPublish(
      new Request(`http://localhost/api/materials/${created.materialId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: creatorCookie(intruder) },
        body: JSON.stringify({}),
      }),
      { params: { id: String(created.materialId) } },
    );
    expect(publishRes.status).toBe(403);
  });

  it("rejects publish when required fields are missing (checklist)", async () => {
    const owner = Keypair.random().publicKey();
    // Bypass the creation route to simulate a legacy/partial material with no file.
    const insertResult = await db.collection("materials").insertOne({
      title: "",
      userAddress: owner,
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const publishRes = await PostPublish(
      new Request(`http://localhost/api/materials/${insertResult.insertedId}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: creatorCookie(owner) },
        body: JSON.stringify({}),
      }),
      { params: { id: String(insertResult.insertedId) } },
    );
    expect(publishRes.status).toBe(400);
    const body = await publishRes.json();
    expect(body.checklist.missingRequired).toEqual(expect.arrayContaining(["file", "title"]));
  });
});

describe("GET /api/market-materials", () => {
  beforeEach(() => {
    db = createTestDb();
  });

  it("lists only public materials and strips storageKey/fileUrl/metadataUrl", async () => {
    await db.collection("materials").insertOne({
      title: "Public Material",
      visibility: "public",
      status: "published",
      storageKey: "secret-cid",
      fileUrl: "secret-cid",
      metadataUrl: "secret-metadata-cid",
      createdAt: new Date(),
      updatedAt: new Date(),
      price: 10,
    });
    await db.collection("materials").insertOne({
      title: "Private Material",
      visibility: "private",
      status: "draft",
      storageKey: "other-cid",
      createdAt: new Date(),
      updatedAt: new Date(),
      price: 10,
    });

    const res = await GetMarketMaterials(new Request("http://localhost/api/market-materials"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].title).toBe("Public Material");
    expect(data.items[0].storageKey).toBeUndefined();
    expect(data.items[0].fileUrl).toBeUndefined();
    expect(data.items[0].metadataUrl).toBeUndefined();
  });

  it("returns a single public material by id", async () => {
    const insertResult = await db.collection("materials").insertOne({
      title: "Single Item",
      visibility: "public",
      status: "published",
      createdAt: new Date(),
      updatedAt: new Date(),
      price: 10,
    });

    const res = await GetMarketMaterials(new Request(`http://localhost/api/market-materials?id=${insertResult.insertedId}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe("Single Item");
  });

  it("returns 404 for a private material fetched by id", async () => {
    const insertResult = await db.collection("materials").insertOne({
      title: "Hidden",
      visibility: "private",
      status: "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await GetMarketMaterials(new Request(`http://localhost/api/market-materials?id=${insertResult.insertedId}`));
    expect(res.status).toBe(404);
  });
});
