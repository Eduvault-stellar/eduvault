import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import migration from "../../src/lib/backend/migrations/006-student-verification-uniqueness.js";

let server;
let client;
let db;

before(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db("student-verification-uniqueness");
});

after(async () => {
  await client?.close();
  await server?.stop();
});

test("migration installs a partial unique index restricted to active statuses", async () => {
  const applications = db.collection("student_verifications");

  // A clean database installs the index without finding any duplicates.
  await migration.up({ db, logger: {} });

  const indexes = await applications.indexes();
  const active = indexes.find(
    (candidate) =>
      candidate.name === "student_verifications_wallet_active_unique",
  );
  assert.ok(active, "the partial unique index should exist after migration");
  assert.equal(active.unique, true);
  assert.deepEqual(active.partialFilterExpression, {
    status: { $in: ["pending", "approved"] },
  });

  // The DB must reject a duplicate active row even if the application code
  // somehow attempts one — this is the final concurrency boundary from
  // #107 acceptance criteria.
  await applications.insertOne({
    walletAddress: "gw-new",
    status: "pending",
    submittedAt: new Date(),
  });
  await assert.rejects(
    applications.insertOne({
      walletAddress: "gw-new",
      status: "pending",
      submittedAt: new Date(),
    }),
    (error) => error?.code === 11000,
  );

  // Terminal rows (rejected/expired) must not be blocked by the same wallet
  // having an active row, and two terminal rows for the same wallet must
  // coexist — neither is constrained by the partial filter.
  await applications.insertOne({
    walletAddress: "gw-terminal",
    status: "rejected",
    submittedAt: new Date(),
  });
  await applications.insertOne({
    walletAddress: "gw-terminal",
    status: "expired",
    submittedAt: new Date(),
  });
  assert.equal(
    await applications.countDocuments({ walletAddress: "gw-terminal" }),
    2,
    "terminal rows should be free of the uniqueness constraint",
  );
});

test("migration detects and archives pre-existing duplicate active rows", async () => {
  // Use a fresh database so the test is independent of the previous one.
  const { client: c2, db: db2 } = await (async () => {
    const client = new MongoClient(server.getUri());
    await client.connect();
    const database = client.db("student-verification-uniqueness-fixture");
    await database.dropDatabase();
    return { client, db: database };
  })();

  try {
    const applications = db2.collection("student_verifications");

    const wallet = "gw-conflict";
    const canonicalId = (
      await applications.insertOne({
        walletAddress: wallet,
        status: "pending",
        submittedAt: new Date("2026-02-01T00:00:00.000Z"),
      })
    ).insertedId;

    const duplicate1Id = (
      await applications.insertOne({
        walletAddress: wallet,
        status: "pending",
        submittedAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    ).insertedId;

    const duplicate2Id = (
      await applications.insertOne({
        walletAddress: wallet,
        status: "approved",
        submittedAt: new Date("2026-01-15T00:00:00.000Z"),
      })
    ).insertedId;

    // Insert a terminal row that should NOT be touched by the migration.
    const terminalId = (
      await applications.insertOne({
        walletAddress: wallet,
        status: "rejected",
        submittedAt: new Date("2026-01-10T00:00:00.000Z"),
      })
    ).insertedId;

    await migration.up({ db: db2, logger: {} });

    // Only the canonical row should remain for this wallet.
    const remaining = await applications
      .find({ walletAddress: wallet })
      .toArray();

    assert.equal(
      remaining.length,
      2,
      "canonical active row + the unrelated terminal row should remain",
    );
    assert.ok(
      remaining.some((doc) => String(doc._id) === String(canonicalId)),
      "the newest active row (canonical) must be preserved",
    );
    assert.ok(
      remaining.some((doc) => String(doc._id) === String(terminalId)),
      "terminal rows must not be affected",
    );
    assert.ok(
      !remaining.some((doc) => String(doc._id) === String(duplicate1Id)),
      "duplicate active row must be removed",
    );
    assert.ok(
      !remaining.some((doc) => String(doc._id) === String(duplicate2Id)),
      "duplicate active row must be removed",
    );

    const conflicts = await db2
      .collection("_migration_conflicts")
      .find({
        migrationVersion: 6,
        sourceCollection: "student_verifications",
        indexName: "student_verifications_wallet_active_unique",
      })
      .toArray();

    assert.equal(
      conflicts.length,
      2,
      "every removed duplicate must be archived in _migration_conflicts",
    );

    for (const conflict of conflicts) {
      assert.deepEqual(conflict.duplicateKey, { walletAddress: wallet });
      assert.equal(
        String(conflict.canonicalSourceId),
        String(canonicalId),
        "each archived conflict must record the canonical survivor",
      );
      assert.equal(conflict.reason, "duplicate-active-verification-wallet");
      assert.ok(conflict.archivedDocument);
    }

    const indexes = await applications.indexes();
    assert.ok(
      indexes.some(
        (candidate) =>
          candidate.name === "student_verifications_wallet_active_unique",
      ),
      "the partial unique index must be installed even after archiving",
    );

    await assert.rejects(
      applications.insertOne({
        walletAddress: wallet,
        status: "pending",
        submittedAt: new Date(),
      }),
      (error) => error?.code === 11000,
      "the index must now actively reject new duplicate inserts",
    );
  } finally {
    await c2.close();
  }
});
