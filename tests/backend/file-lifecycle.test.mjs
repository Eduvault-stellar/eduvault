import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import {
  registerFile,
  getFileForRequester,
  replaceFile,
  deleteFile,
  runFileCleanup,
  detectOrphans,
  normalizeStorageKey,
  FileAuthorizationError,
  FileValidationError,
  FileNotFoundError,
} from "../../src/lib/uploads/fileLifecycle.js";
import { COLLECTIONS, FILE_STATES } from "../../src/lib/backend/schemaContracts.js";
import { createFakeDb } from "./helpers/fakeMongo.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function avatarInput(owner, bytes) {
  return {
    ownerId: owner,
    purpose: "avatar",
    parentType: "user",
    parentId: owner,
    fileName: "a.png",
    mimeType: "image/png",
    size: bytes.length,
    checksum: sha256(bytes),
    content: bytes,
  };
}

describe("registerFile — validation", () => {
  test("rejects a file over its purpose byte limit", async () => {
    const db = createFakeDb();
    const big = Buffer.alloc(6 * 1024 * 1024, 1); // avatar cap is 5MB
    await assert.rejects(
      () => registerFile(db, avatarInput("gowner", big)),
      (e) => e instanceof FileValidationError && /limit for avatar/.test(e.message),
    );
    assert.equal(db.dump(COLLECTIONS.files).length, 0, "nothing is stored for a rejected file");
  });

  test("rejects content whose checksum does not match the claim (spoofed)", async () => {
    const db = createFakeDb();
    const bytes = Buffer.from("real content");
    await assert.rejects(
      () => registerFile(db, { ...avatarInput("gowner", bytes), checksum: sha256(Buffer.from("something else")) }),
      (e) => e instanceof FileValidationError && /checksum does not match/.test(e.message),
    );
  });

  test("rejects a declared size that disagrees with the content", async () => {
    const db = createFakeDb();
    const bytes = Buffer.from("twelve bytes");
    await assert.rejects(
      () => registerFile(db, { ...avatarInput("gowner", bytes), size: 999 }),
      (e) => e instanceof FileValidationError && /size does not match/.test(e.message),
    );
  });

  test("rejects an unknown purpose", async () => {
    const db = createFakeDb();
    await assert.rejects(
      () => registerFile(db, { ownerId: "g", purpose: "nope", mimeType: "image/png", size: 1, checksum: sha256(Buffer.from("x")) }),
      (e) => e instanceof FileValidationError && /unknown file purpose/.test(e.message),
    );
  });
});

describe("registerFile — dedupe", () => {
  test("identical content for the same owner resolves to one object", async () => {
    const db = createFakeDb();
    const bytes = Buffer.from("same bytes");

    const first = await registerFile(db, avatarInput("gowner", bytes));
    const second = await registerFile(db, avatarInput("gowner", bytes));

    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(second.file.storageKey, first.file.storageKey);
    assert.equal(db.dump(COLLECTIONS.files).length, 1);
  });

  test("the same bytes from a different owner is a distinct object", async () => {
    const db = createFakeDb();
    const bytes = Buffer.from("shared bytes");

    await registerFile(db, avatarInput("gowner-a", bytes));
    const other = await registerFile(db, avatarInput("gowner-b", bytes));

    assert.equal(other.deduped, false);
    assert.equal(db.dump(COLLECTIONS.files).length, 2);
  });
});

describe("authorization", () => {
  test("a public avatar is readable by anyone", async () => {
    const db = createFakeDb();
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("pic")));

    const seen = await getFileForRequester(db, file.storageKey, "gstranger");
    assert.equal(seen.storageKey, file.storageKey);
  });

  test("a private file is invisible to a non-owner, and indistinguishable from missing", async () => {
    const db = createFakeDb();
    const bytes = Buffer.from("secret evidence");
    const { file } = await registerFile(db, {
      ownerId: "gowner",
      purpose: "milestone_evidence",
      parentType: "milestone",
      parentId: "m1",
      fileName: "evidence.pdf",
      mimeType: "application/pdf",
      size: bytes.length,
      checksum: sha256(bytes),
      content: bytes,
    });

    await assert.rejects(
      () => getFileForRequester(db, file.storageKey, "gstranger"),
      (e) => e instanceof FileNotFoundError,
    );
    // The owner still sees it.
    const owned = await getFileForRequester(db, file.storageKey, "gowner");
    assert.equal(owned.visibility, "private");
  });

  test("a non-owner cannot delete another tenant's file", async () => {
    const db = createFakeDb();
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("mine")));

    await assert.rejects(
      () => deleteFile(db, { requesterId: "gattacker", storageKey: file.storageKey }),
      (e) => e instanceof FileAuthorizationError,
    );
    assert.equal(db.dump(COLLECTIONS.files)[0].state, FILE_STATES.ACTIVE, "the file is untouched");
  });

  test("a non-owner cannot replace another tenant's file", async () => {
    const db = createFakeDb();
    await registerFile(db, avatarInput("gowner", Buffer.from("v1")));

    await assert.rejects(
      () => replaceFile(db, {
        requesterId: "gattacker",
        parentType: "user",
        parentId: "gowner",
        purpose: "avatar",
        fileName: "evil.png",
        mimeType: "image/png",
        size: 2,
        checksum: sha256(Buffer.from("v2")),
        content: Buffer.from("v2"),
      }),
      (e) => e instanceof FileAuthorizationError,
    );
  });
});

describe("replace + transactional delete", () => {
  test("replacing an avatar enqueues the old object for cleanup", async () => {
    const db = createFakeDb({ transactions: true });
    const v1 = Buffer.from("avatar v1");
    await registerFile(db, avatarInput("gowner", v1));

    const v2 = Buffer.from("avatar v2 bytes");
    const result = await replaceFile(db, {
      requesterId: "gowner",
      parentType: "user",
      parentId: "gowner",
      purpose: "avatar",
      fileName: "new.png",
      mimeType: "image/png",
      size: v2.length,
      checksum: sha256(v2),
      content: v2,
    });

    assert.equal(result.replaced, true);
    const outbox = db.dump(COLLECTIONS.fileCleanupOutbox);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].reason, "replaced");

    const oldRecord = db.dump(COLLECTIONS.files).find((f) => f.checksum === sha256(v1));
    assert.equal(oldRecord.state, FILE_STATES.PENDING_DELETION);
  });

  test("delete moves the record to pending_deletion and enqueues cleanup atomically", async () => {
    const db = createFakeDb({ transactions: true });
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("bye")));

    const res = await deleteFile(db, { requesterId: "gowner", storageKey: file.storageKey });
    assert.equal(res.state, FILE_STATES.PENDING_DELETION);
    assert.equal(db.dump(COLLECTIONS.fileCleanupOutbox).length, 1);
  });
});

describe("cleanup worker", () => {
  test("removes storage, tombstones the record, and clears the task", async () => {
    const db = createFakeDb();
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("data")));
    await deleteFile(db, { requesterId: "gowner", storageKey: file.storageKey });

    const removedKeys = [];
    const remove = async (key) => { removedKeys.push(key); };

    const result = await runFileCleanup(db, remove);

    assert.equal(result.removed, 1);
    assert.deepEqual(removedKeys, [file.storageKey]);
    assert.equal(db.dump(COLLECTIONS.fileCleanupOutbox).length, 0);
    assert.equal(db.dump(COLLECTIONS.files)[0].state, FILE_STATES.DELETED);
  });

  test("a failing storage removal is retried with backoff, not lost", async () => {
    const db = createFakeDb();
    const enqueuedAt = new Date("2026-01-01T00:00:00Z");
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("data")));
    await deleteFile(db, { requesterId: "gowner", storageKey: file.storageKey }, { now: enqueuedAt });

    const remove = async () => { throw new Error("storage down"); };
    // Cleanup runs after the task became due.
    const result = await runFileCleanup(db, remove, { now: new Date("2026-01-01T00:01:00Z") });

    assert.equal(result.removed, 0);
    assert.equal(result.failed.length, 1);
    const task = db.dump(COLLECTIONS.fileCleanupOutbox)[0];
    assert.equal(task.attempts, 1);
    assert.equal(task.status, "pending");
    assert.ok(new Date(task.nextAttemptAt) > new Date("2026-01-01T00:01:00Z"), "backoff pushes the retry out");
    // The record is NOT tombstoned while cleanup is unconfirmed.
    assert.equal(db.dump(COLLECTIONS.files)[0].state, FILE_STATES.PENDING_DELETION);
  });

  test("gives up after maxAttempts and marks the task failed", async () => {
    const db = createFakeDb();
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("data")));
    await deleteFile(db, { requesterId: "gowner", storageKey: file.storageKey });

    const remove = async () => { throw new Error("permanent"); };
    // Force nextAttemptAt into the past each pass so the task stays due.
    for (let i = 0; i < 5; i += 1) {
      await db.collection(COLLECTIONS.fileCleanupOutbox).updateOne(
        { storageKey: file.storageKey },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      await runFileCleanup(db, remove, { maxAttempts: 5 });
    }
    assert.equal(db.dump(COLLECTIONS.fileCleanupOutbox)[0].status, "failed");
  });
});

describe("orphan detection", () => {
  test("dry-run reports storage objects with no live record without writing", async () => {
    const db = createFakeDb();
    const { file } = await registerFile(db, avatarInput("gowner", Buffer.from("kept")));

    const storageKeys = [file.storageKey, "avatar/gowner/deadbeef".padEnd(20, "0")];
    const report = await detectOrphans(db, async () => storageKeys, { mode: "dryRun" });

    assert.equal(report.orphanedStorageKeys.length, 1);
    assert.equal(report.enqueued, 0);
    assert.equal(db.dump(COLLECTIONS.fileCleanupOutbox).length, 0, "dry run writes nothing");
  });

  test("apply mode enqueues orphaned storage keys for cleanup", async () => {
    const db = createFakeDb();
    const orphanKey = "material/gowner/" + "a".repeat(64);
    const report = await detectOrphans(db, async () => [orphanKey], { mode: "apply" });

    assert.equal(report.enqueued, 1);
    const outbox = db.dump(COLLECTIONS.fileCleanupOutbox);
    assert.equal(outbox[0].storageKey, orphanKey);
    assert.equal(outbox[0].reason, "orphan");
  });
});

describe("normalizeStorageKey", () => {
  test("lowercases, namespaces by purpose, and strips traversal", () => {
    const key = normalizeStorageKey({ purpose: "avatar", ownerId: "GOwner_1", checksum: "A".repeat(64) });
    assert.equal(key, `avatar/gowner_1/${"a".repeat(64)}`);
  });

  test("rejects an identity that cannot produce a safe key", () => {
    assert.throws(
      () => normalizeStorageKey({ purpose: "../etc", ownerId: "../../root", checksum: "nothex" }),
      (e) => e instanceof FileValidationError,
    );
  });
});
