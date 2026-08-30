import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  createUploadSession,
  reclaimUploadSessions,
} from "../../src/lib/ipfs/uploadSessions.js";
import {
  StorageQuotaExceededError,
  reserveOwnerStorage,
} from "../../src/lib/uploads/storageQuotas.js";

let server;
let client;
let db;

const digest = "a".repeat(64);

before(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("upload-session-quota");
});

after(async () => {
  await client?.close();
  await server?.stop();
});

function fileSpec(size) {
  return { fileName: "lecture.mp4", mimeType: "video/mp4", size, sha256: digest };
}

test("concurrent reservations for the same owner never exceed the quota", async () => {
  const ownerId = "owner-race";
  const quotaBytes = 10 * 1024 * 1024;
  const bytesPerReservation = 4 * 1024 * 1024;

  // Regression: before atomic accounting, each of these could independently
  // read "room available" and all succeed, reserving 5x the actual quota.
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      reserveOwnerStorage(db, { ownerId, bytes: bytesPerReservation, quotaBytes }),
    ),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(succeeded.length, 2, "only two 4MB reservations fit in a 10MB quota");
  assert.equal(failed.length, 3);
  for (const rejection of failed) {
    assert.ok(rejection.reason instanceof StorageQuotaExceededError);
  }

  const quotaDoc = await db.collection("owner_storage_quotas").findOne({ ownerId });
  assert.equal(quotaDoc.reservedBytes, bytesPerReservation * 2);
});

test("createUploadSession rejects a session that would exceed the owner's quota", async () => {
  const ownerId = "owner-session-quota";
  const quotaBytes = 5 * 1024 * 1024;
  // Pre-fill the owner's quota so the very first session request already
  // exceeds it.
  await db.collection("owner_storage_quotas").insertOne({ ownerId, reservedBytes: quotaBytes, createdAt: new Date(), updatedAt: new Date() });

  await assert.rejects(
    () =>
      createUploadSession(db, {
        ownerId,
        idempotencyKey: "session-1",
        file: fileSpec(1024 * 1024),
      }),
    (error) => {
      assert.ok(error instanceof StorageQuotaExceededError);
      return true;
    },
  );

  assert.equal(await db.collection("upload_sessions").countDocuments({ ownerId }), 0);
});

test("a retried request with the same Idempotency-Key does not double-reserve quota", async () => {
  const ownerId = "owner-idempotent";
  const idempotencyKey = "retry-key";
  const file = fileSpec(1024 * 1024);

  const first = await createUploadSession(db, { ownerId, idempotencyKey, file });
  const second = await createUploadSession(db, { ownerId, idempotencyKey, file });

  assert.equal(first._id, second._id);
  const quotaDoc = await db.collection("owner_storage_quotas").findOne({ ownerId });
  assert.equal(quotaDoc.reservedBytes, file.size, "the retry must not add a second reservation");
});

test("reclaiming an expired session releases its reservation back to the owner's quota", async () => {
  const ownerId = "owner-reclaim";
  const file = fileSpec(2 * 1024 * 1024);

  const session = await createUploadSession(db, { ownerId, idempotencyKey: "expiring", file });
  await db.collection("upload_sessions").updateOne(
    { _id: session._id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );

  let quotaDoc = await db.collection("owner_storage_quotas").findOne({ ownerId });
  assert.equal(quotaDoc.reservedBytes, file.size);

  const unpin = async () => {};
  const result = await reclaimUploadSessions(db, unpin, { now: new Date() });
  assert.equal(result.cleaned, 1);

  quotaDoc = await db.collection("owner_storage_quotas").findOne({ ownerId });
  assert.equal(quotaDoc.reservedBytes, 0, "the released reservation must return to the available quota");

  // The freed capacity is usable again.
  const nextSession = await createUploadSession(db, { ownerId, idempotencyKey: "after-reclaim", file });
  assert.ok(nextSession._id);
});
