import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import migration from "../../src/lib/backend/migrations/005-saved-material-uniqueness.js";

let server;
let client;
let db;

before(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("saved-material-uniqueness");
});

after(async () => {
  await client?.close();
  await server?.stop();
});

test("migration archives legacy duplicates before creating the unique index", async () => {
  const bookmarks = db.collection("saved_materials");
  const first = { walletAddress: "g-user", materialId: "material-1", savedAt: new Date(1) };
  const duplicate = { ...first, savedAt: new Date(2) };
  await bookmarks.insertMany([first, duplicate]);

  await migration.up({ db, logger: {} });

  assert.equal(await bookmarks.countDocuments(first), 1);
  assert.equal(
    await db.collection("_migration_conflicts").countDocuments({
      migrationVersion: 5,
      sourceCollection: "saved_materials",
    }),
    1,
  );
  const index = (await bookmarks.indexes()).find(
    (candidate) => candidate.name === "saved_materials_wallet_material_unique",
  );
  assert.equal(index?.unique, true);
});

test("concurrent record-idempotent upserts produce exactly one bookmark", async () => {
  const bookmarks = db.collection("saved_materials");
  const filter = { walletAddress: "g-race", materialId: "material-2" };

  await Promise.all(
    Array.from({ length: 20 }, () =>
      bookmarks.updateOne(
        filter,
        { $setOnInsert: { ...filter, savedAt: new Date() } },
        { upsert: true },
      ),
    ),
  );

  assert.equal(await bookmarks.countDocuments(filter), 1);
});
