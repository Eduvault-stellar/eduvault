import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeOrderedMaterialIds,
  requestedRevision,
  revisionFilter,
  revisionUpdatePipeline,
} from "../../src/lib/collections/integrity.js";

test("material ordering is stable and duplicate-free", () => {
  assert.deepEqual(
    normalizeOrderedMaterialIds(["b", "a", "b", "c", "a"]),
    ["b", "a", "c"],
  );
});

test("revision can be supplied as a strong or weak ETag", () => {
  for (const value of ['"7"', 'W/"7"']) {
    const request = new Request("https://example.test", { headers: { "if-match": value } });
    assert.equal(requestedRevision(request), 7);
  }
});

test("legacy collections participate in revision 1 compare-and-swap", () => {
  assert.deepEqual(revisionFilter({ id: "id", creatorId: "user", revision: 1 }), {
    _id: "id",
    creatorId: "user",
    $or: [{ revision: 1 }, { revision: { $exists: false } }],
  });
});

test("update pipeline advances the stored revision atomically", () => {
  const now = new Date(123);
  assert.deepEqual(revisionUpdatePipeline({ title: "Updated" }, now), [
    {
      $set: {
        title: "Updated",
        updatedAt: now,
        revision: { $add: [{ $ifNull: ["$revision", 1] }, 1] },
      },
    },
  ]);
});
