import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  ImportConflictError,
  publishMaterialImport,
  validateImportPayload,
} from "../../src/lib/backend/materialImport.js";

let server;
let client;
let db;

const records = validateImportPayload({
  dryRun: false,
  records: [
    { recordId: "source-1", title: "First", storageKey: "ipfs://first" },
    { recordId: "source-2", title: "Second", storageKey: "ipfs://second" },
  ],
}).validRecords;

before(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("material-import-resume");
});

after(async () => {
  await client?.close();
  await server?.stop();
});

test("resumes a partial import without duplicating its successful row", async () => {
  let writes = 0;
  const failingDb = {
    collection(name) {
      const collection = db.collection(name);
      if (name !== "materials") return collection;
      return new Proxy(collection, {
        get(target, property) {
          if (property === "updateOne") {
            return async (...args) => {
              writes += 1;
              if (writes === 2) throw new Error("simulated disconnect");
              return target.updateOne(...args);
            };
          }
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };

  const first = await publishMaterialImport(failingDb, {
    ownerId: "creator-1",
    userAddress: "gcreator",
    importId: "batch-1",
    records,
  });
  assert.equal(first.status, "partial");
  assert.equal(first.completed, 1);
  assert.equal(first.failed, 1);

  const resumed = await publishMaterialImport(db, {
    ownerId: "creator-1",
    userAddress: "gcreator",
    importId: "batch-1",
    records,
  });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.imported, 1);
  assert.equal(resumed.reused, 1);
  assert.equal(await db.collection("materials").countDocuments(), 2);

  const replay = await publishMaterialImport(db, {
    ownerId: "creator-1",
    userAddress: "gcreator",
    importId: "batch-1",
    records,
  });
  assert.equal(replay.imported, 0);
  assert.equal(replay.reused, 2);
  assert.equal(await db.collection("materials").countDocuments(), 2);
});

test("rejects reuse of an import identity with changed record data", async () => {
  await assert.rejects(
    publishMaterialImport(db, {
      ownerId: "creator-1",
      userAddress: "gcreator",
      importId: "batch-1",
      records: [{ ...records[0], title: "Changed after publication" }, records[1]],
    }),
    ImportConflictError,
  );
});
