import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  acquireStorageClaim,
  releaseStorageClaim,
  StorageCleanupConflictError,
} from "../../src/lib/uploads/storageClaims.js";

const OUTBOX = "file_cleanup_outbox";

function createClaimDb() {
  const documents = [];
  const matches = (document, filter) => Object.entries(filter).every(([key, value]) => document[key] === value);
  const collection = {
    async findOne(filter) {
      return documents.find((document) => matches(document, filter)) || null;
    },
    async insertOne(document) {
      if (documents.some((existing) => existing.storageKey === document.storageKey)) {
        const error = new Error("duplicate storageKey");
        error.code = 11000;
        throw error;
      }
      documents.push({ ...document });
    },
    async updateOne(filter, update) {
      const document = documents.find((candidate) => matches(candidate, filter));
      if (!document) return { matchedCount: 0 };
      Object.assign(document, update.$set || {});
      return { matchedCount: 1 };
    },
    async deleteOne(filter) {
      const index = documents.findIndex((document) => matches(document, filter));
      if (index < 0) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
  return {
    collection(name) {
      assert.equal(name, OUTBOX);
      return collection;
    },
    dump() {
      return documents.map((document) => ({ ...document }));
    },
  };
}

describe("storage cleanup claims", () => {
  test("atomically takes over a pending orphan task while ownership is committed", async () => {
    const db = createClaimDb();
    const outbox = db.collection(OUTBOX);
    await outbox.insertOne({
      storageKey: "bafy-race",
      reason: "orphan",
      status: "pending",
      nextAttemptAt: new Date(0),
    });

    await acquireStorageClaim(db, "bafy-race", "upload:1");
    assert.equal(db.dump()[0].status, "claimed");

    await releaseStorageClaim(db, "bafy-race", "upload:1");
    assert.equal(db.dump().length, 0);
  });

  test("fails closed once cleanup is processing the object", async () => {
    const db = createClaimDb();
    await db.collection(OUTBOX).insertOne({
      storageKey: "bafy-processing",
      reason: "orphan",
      status: "processing",
    });

    await assert.rejects(
      acquireStorageClaim(db, "bafy-processing", "upload:2"),
      StorageCleanupConflictError,
    );
  });
});
