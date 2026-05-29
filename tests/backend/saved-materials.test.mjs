import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { MongoClient } from "mongodb";

const TEST_DB = "eduvault_test_saved";
const TEST_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";

let client;
let db;

before(async () => {
  client = new MongoClient(TEST_URI);
  await client.connect();
  db = client.db(TEST_DB);
});

after(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("Saved Materials Collection", () => {
  test("inserts a saved material entry", async () => {
    const doc = {
      walletAddress: "gbtest123...abc",
      materialId: "507f191e810c19729de860ea",
      savedAt: new Date(),
    };

    const result = await db.collection("saved_materials").insertOne(doc);
    assert.ok(result.insertedId);

    const found = await db.collection("saved_materials").findOne({ materialId: doc.materialId });
    assert.equal(found.walletAddress, doc.walletAddress);
  });

  test("duplicate save is prevented by unique index", async () => {
    const collection = db.collection("saved_materials");
    await collection.createIndex(
      { walletAddress: 1, materialId: 1 },
      { unique: true }
    );

    const doc = {
      walletAddress: "gcqatest...xyz",
      materialId: "507f191e810c19729de860eb",
      savedAt: new Date(),
    };

    await collection.insertOne(doc);

    await assert.rejects(
      () => collection.insertOne(doc),
      /duplicate key/
    );
  });

  test("lists saved materials by wallet address", async () => {
    const wallet = "gblisttest...123";
    const items = [
      { walletAddress: wallet, materialId: "aaa", savedAt: new Date() },
      { walletAddress: wallet, materialId: "bbb", savedAt: new Date() },
    ];

    await db.collection("saved_materials").insertMany(items);

    const found = await db
      .collection("saved_materials")
      .find({ walletAddress: wallet })
      .sort({ savedAt: -1 })
      .toArray();

    assert.equal(found.length, 2);
  });

  test("deletes a saved material entry", async () => {
    const wallet = "gbdeltest...456";
    const materialId = "ccc";

    await db.collection("saved_materials").insertOne({
      walletAddress: wallet,
      materialId,
      savedAt: new Date(),
    });

    const result = await db.collection("saved_materials").deleteOne({
      walletAddress: wallet,
      materialId,
    });

    assert.equal(result.deletedCount, 1);

    const found = await db.collection("saved_materials").findOne({
      walletAddress: wallet,
      materialId,
    });
    assert.equal(found, null);
  });

  test("empty state returns empty array", async () => {
    const wallet = "gbemptytest...789";
    const found = await db
      .collection("saved_materials")
      .find({ walletAddress: wallet })
      .toArray();

    assert.deepEqual(found, []);
  });
});
