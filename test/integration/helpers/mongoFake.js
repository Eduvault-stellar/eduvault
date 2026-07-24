import { ObjectId } from "mongodb";
import { createFakeDb } from "../../../tests/backend/helpers/fakeMongo.mjs";

/**
 * Query matching for the collection methods reimplemented below. A superset
 * of fakeMongo.mjs's own (private, non-exported) matcher:
 *  - adds $gt/$gte/$lt/$lte (needed by `verifyChallenge`'s
 *    `expiresAt: { $gt: now }` guard)
 *  - treats BSON ObjectId as an opaque, type-strict value compared via
 *    `.equals()` rather than as a nested operator object (fakeMongo.mjs's
 *    matcher walks *any* object's entries as if they were `$operator: value`
 *    pairs, which corrupts on `{ _id: new ObjectId(x) }` — a filter shape
 *    almost every real route uses). ObjectId vs. a plain string never
 *    matches here, same as real MongoDB (no implicit cast).
 * Kept separate from the shared helper so tests/backend's behavior, and its
 * fault-injection/transaction tests, are untouched.
 */
function isObjectId(value) {
  return Boolean(value) && typeof value === "object" && typeof value.equals === "function" && value._bsontype === "ObjectId";
}

function valuesEqual(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (isObjectId(a) || isObjectId(b)) {
    if (!isObjectId(a) || !isObjectId(b)) return false;
    return a.equals(b);
  }
  return a === b;
}

function isOperatorObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !isObjectId(value)
  );
}

function matchesCondition(value, condition) {
  if (isOperatorObject(condition)) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case "$in":
          if (!operand.some((candidate) => valuesEqual(value, candidate))) return false;
          break;
        case "$nin":
          if (operand.some((candidate) => valuesEqual(value, candidate))) return false;
          break;
        case "$exists":
          if ((value !== undefined) !== operand) return false;
          break;
        case "$ne":
          if (valuesEqual(value, operand)) return false;
          break;
        case "$gt":
          if (!(value > operand)) return false;
          break;
        case "$gte":
          if (!(value >= operand)) return false;
          break;
        case "$lt":
          if (!(value < operand)) return false;
          break;
        case "$lte":
          if (!(value <= operand)) return false;
          break;
        case "$type":
          if (operand === "string" && typeof value !== "string") return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  return valuesEqual(value, condition);
}

function matchesFilter(doc, filter = {}) {
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "$or") {
      if (!condition.some((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (field === "$and") {
      if (!condition.every((clause) => matchesFilter(doc, clause))) return false;
      continue;
    }
    if (!matchesCondition(doc[field], condition)) return false;
  }
  return true;
}

/** Re-derives literal-value seeds from a filter, for `upsert`/`findOneAndUpdate` inserts. */
function literalsFrom(filter) {
  const seed = {};
  for (const [field, condition] of Object.entries(filter)) {
    if (field.startsWith("$")) continue;
    if (!isOperatorObject(condition)) seed[field] = condition;
  }
  return seed;
}

function assertUnique(col, candidate, existing) {
  for (const index of col.indexes) {
    if (!index.options?.unique) continue;

    const partial = index.options.partialFilterExpression;
    if (partial && !matchesFilter(candidate, partial)) continue;

    const fields = Object.keys(index.keys);
    const clash = col.docs.some((doc) => {
      if (doc === existing) return false;
      if (partial && !matchesFilter(doc, partial)) return false;
      return fields.every((field) => valuesEqual(doc[field], candidate[field]));
    });

    if (clash) {
      const error = new Error(`E11000 duplicate key error collection: index: ${index.name}`);
      error.code = 11000;
      throw error;
    }
  }
}

/**
 * Wraps `tests/backend/helpers/fakeMongo.mjs`'s `createFakeDb()` for use from
 * vitest integration tests.
 *
 * fakeMongo.mjs is deliberately partial (see its own header comment): its
 * `find()` cursor has no `.sort()`/`.skip()`, it has no `findOneAndUpdate`,
 * its `insertOne` doesn't auto-generate `_id` the way real MongoDB does, and
 * its internal filter matcher mishandles `ObjectId` filter values (treats
 * them as nested `$operator` maps instead of opaque values). Real routes
 * under test rely on all of these. Rather than editing the shared helper
 * (also used by tests/backend, which doesn't hit these gaps), this file
 * layers replacement query methods on top of it, reusing each collection's
 * own `docs`/`indexes` arrays so state stays consistent across methods.
 */
export function createTestDb(options) {
  const db = createFakeDb(options);
  const originalCollection = db.collection.bind(db);

  db.collection = (name) => {
    const col = originalCollection(name);

    const originalInsertOne = col.insertOne.bind(col);
    col.insertOne = async (doc, opts) => {
      if (doc._id === undefined) doc._id = new ObjectId();
      return originalInsertOne(doc, opts);
    };

    col.findOne = async (filter = {}) => {
      const doc = col.docs.find((candidate) => matchesFilter(candidate, filter));
      return doc ? { ...doc } : null;
    };

    col.countDocuments = async (filter = {}) => col.docs.filter((doc) => matchesFilter(doc, filter)).length;

    col.deleteOne = async (filter = {}) => {
      const index = col.docs.findIndex((doc) => matchesFilter(doc, filter));
      if (index === -1) return { deletedCount: 0 };
      col.docs.splice(index, 1);
      return { deletedCount: 1 };
    };

    col.updateOne = async (filter = {}, update = {}, opts = {}) => {
      const existing = col.docs.find((doc) => matchesFilter(doc, filter));

      if (!existing && !opts.upsert) return { matchedCount: 0, modifiedCount: 0 };

      if (!existing) {
        const candidate = {
          ...literalsFrom(filter),
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        };
        if (candidate._id === undefined) candidate._id = new ObjectId();
        assertUnique(col, candidate, null);
        col.docs.push(candidate);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: candidate._id };
      }

      const candidate = { ...existing, ...(update.$set || {}) };
      assertUnique(col, candidate, existing);
      Object.assign(existing, update.$set || {});
      return { matchedCount: 1, modifiedCount: 1 };
    };

    col.findOneAndUpdate = async (filter = {}, update = {}, opts = {}) => {
      const index = col.docs.findIndex((doc) => matchesFilter(doc, filter));

      if (index === -1) {
        if (!opts.upsert) return null;
        const seed = {
          ...literalsFrom(filter),
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        };
        if (seed._id === undefined) seed._id = new ObjectId();
        col.docs.push(seed);
        return opts.returnDocument === "before" ? null : { ...seed };
      }

      const before = { ...col.docs[index] };
      const after = { ...before, ...(update.$set || {}) };
      col.docs[index] = after;
      return opts.returnDocument === "before" ? before : { ...after };
    };

    // fakeMongo.mjs's `find()` cursor only supports `.limit()`/`.toArray()`.
    // Real routes under test also chain `.sort()`/`.skip()` (e.g.
    // GET /api/purchase, GET /api/market-materials).
    col.find = (filter = {}) => {
      const results = col.docs.filter((doc) => matchesFilter(doc, filter));
      let sortSpec = null;
      let skipCount = 0;
      let limitCount = null;
      const cursor = {
        sort(spec) {
          sortSpec = spec;
          return cursor;
        },
        skip(count) {
          skipCount = count;
          return cursor;
        },
        limit(count) {
          limitCount = count;
          return cursor;
        },
        async toArray() {
          let out = [...results];
          if (sortSpec) {
            const entries = Object.entries(sortSpec);
            out = out.sort((a, b) => {
              for (const [key, direction] of entries) {
                if (a[key] < b[key]) return -1 * direction;
                if (a[key] > b[key]) return 1 * direction;
              }
              return 0;
            });
          }
          if (skipCount) out = out.slice(skipCount);
          if (limitCount != null) out = out.slice(0, limitCount);
          return out.map((doc) => ({ ...doc }));
        },
        async *[Symbol.asyncIterator]() {
          for (const doc of await cursor.toArray()) yield doc;
        },
      };
      return cursor;
    };

    return col;
  };

  return db;
}
