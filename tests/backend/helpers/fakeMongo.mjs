/**
 * An in-memory Mongo double that enforces unique indexes and can inject write
 * faults.
 *
 * The existing indexer test double keys documents as
 * `query._id || \`${materialId}:${buyerAddress}\`` and models no constraints,
 * so a duplicate-key error is unrepresentable and a crash mid-batch is
 * unsimulatable. That makes the two scenarios the indexer most needs to
 * survive — replay and checkpoint resume — exactly the two it cannot be tested
 * for. This double exists to close that gap.
 *
 * It is deliberately partial: it implements the query and update shapes the
 * indexer actually uses, and throws on anything it does not understand rather
 * than silently returning wrong results.
 */

import { randomBytes } from "node:crypto";
import { REQUIRED_INDEXES } from "../../../src/lib/backend/schemaContracts.js";

function duplicateKeyError(indexName, key) {
  const error = new Error(
    `E11000 duplicate key error collection: index: ${indexName} dup key: ${JSON.stringify(key)}`,
  );
  error.code = 11000;
  return error;
}

/**
 * Minimal ObjectId stand-in that satisfies the equality checks used by the
 * indexer / lifecycle tests. We don't need a real 12-byte ObjectId — only
 * stable identity and a stringification that matches what production code
 * does (`String(id)`) when comparing ids.
 */
class FakeObjectId {
  constructor(hex) {
    this.hex = hex || randomBytes(12).toString("hex");
  }
  toString() {
    return this.hex;
  }
  toJSON() {
    return this.hex;
  }
}
function isFakeObjectId(value) {
  return value instanceof FakeObjectId;
}

/**
 * Mirrors MongoDB's `$unset` semantics for dotted paths (e.g.
 * "document.encrypted") by walking the path and removing only the leaf key
 * if every intermediate object exists. This is intentionally narrower than
 * Mongo's full behaviour — we only support unsetting existing leaves, which
 * is all the lifecycle / indexer code we test needs.
 */
function unsetNestedField(target, path) {
  const segments = path.split(".");
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (cursor == null || typeof cursor !== "object") return;
    cursor = cursor[segment];
  }
  if (cursor == null || typeof cursor !== "object") return;
  delete cursor[segments[segments.length - 1]];
}

const TYPE_CHECKS = {
  string: (value) => typeof value === "string",
  int: (value) => Number.isInteger(value),
  bool: (value) => typeof value === "boolean",
  date: (value) => value instanceof Date,
};

function matchesCondition(value, condition) {
  if (
    condition &&
    typeof condition === "object" &&
    !Array.isArray(condition) &&
    !(condition instanceof Date) &&
    !isFakeObjectId(condition)
  ) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case "$in":
          if (!operand.includes(value)) return false;
          break;
        case "$nin":
          if (operand.includes(value)) return false;
          break;
        case "$exists":
          if ((value !== undefined) !== operand) return false;
          break;
        case "$ne":
          if (value === operand) return false;
          break;
        case "$lt":
        case "$lte":
        case "$gt":
        case "$gte": {
          // Comparison works for numbers and Dates. A missing value never
          // satisfies a range predicate, matching Mongo.
          if (value === undefined || value === null) return false;
          const a = value instanceof Date ? value.getTime() : value;
          const b = operand instanceof Date ? operand.getTime() : operand;
          if (operator === "$lt" && !(a < b)) return false;
          if (operator === "$lte" && !(a <= b)) return false;
          if (operator === "$gt" && !(a > b)) return false;
          if (operator === "$gte" && !(a >= b)) return false;
          break;
        }
        case "$type": {
          const check = TYPE_CHECKS[operand];
          if (!check) throw new Error(`fakeMongo: unsupported $type "${operand}"`);
          if (!check(value)) return false;
          break;
        }
        default:
          throw new Error(`fakeMongo: unsupported operator "${operator}"`);
      }
    }
    return true;
  }

  if (value instanceof Date && condition instanceof Date) return value.getTime() === condition.getTime();
  if (isFakeObjectId(condition)) {
    if (isFakeObjectId(value)) return value.toString() === condition.toString();
    return value === condition.toString();
  }
  if (isFakeObjectId(value) && typeof condition === "string") return value.toString() === condition;
  if (typeof value === "string" && isFakeObjectId(condition)) return value === condition.toString();
  if (isFakeObjectId(value) && isFakeObjectId(condition)) return value.toString() === condition.toString();
  return value === condition;
}

export function matchesFilter(doc, filter = {}) {
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

/** Fields a filter pins to a literal value, used to seed an upserted doc. */
function literalsFrom(filter) {
  const seed = {};
  for (const [field, condition] of Object.entries(filter)) {
    if (field.startsWith("$")) continue;
    const isOperator =
      condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date);
    if (!isOperator) seed[field] = condition;
  }
  return seed;
}

class FakeCollection {
  constructor(name, indexes, faults) {
    this.name = name;
    this.indexes = indexes;
    this.faults = faults;
    this.docs = [];
    this.writes = 0;
  }

  /** Throws if a registered fault matches this write. */
  #maybeFail(operation) {
    this.writes += 1;
    for (const fault of this.faults) {
      if (fault.collection !== this.name) continue;
      if (fault.operation && fault.operation !== operation) continue;
      if (fault.afterWrites !== undefined && this.writes <= fault.afterWrites) continue;
      if (fault.remaining !== undefined) {
        if (fault.remaining <= 0) continue;
        fault.remaining -= 1;
      }
      throw fault.error ?? new Error(`fakeMongo: injected ${operation} failure on ${this.name}`);
    }
  }

  #assertUnique(candidate, existing) {
    for (const index of this.indexes) {
      if (!index.options?.unique) continue;

      const partial = index.options.partialFilterExpression;
      if (partial && !matchesFilter(candidate, partial)) continue;

      const fields = Object.keys(index.keys);
      const key = Object.fromEntries(fields.map((field) => [field, candidate[field]]));

      const clash = this.docs.some((doc) => {
        if (doc === existing) return false;
        if (partial && !matchesFilter(doc, partial)) return false;
        return fields.every((field) => doc[field] === candidate[field]);
      });

      if (clash) throw duplicateKeyError(index.name, key);
    }
  }

  async findOne(filter = {}) {
    return this.docs.find((doc) => matchesFilter(doc, filter)) ?? null;
  }

  async insertOne(doc) {
    this.#maybeFail("insertOne");
    const candidate = { ...doc };
    if (candidate._id === undefined) {
      candidate._id = new FakeObjectId();
    } else if (this.docs.some((existing) => existing._id === candidate._id)) {
      throw duplicateKeyError(`${this.name}_id_`, { _id: candidate._id });
    }
    this.#assertUnique(candidate, null);
    this.docs.push(candidate);
    return { insertedId: candidate._id };
  }

  async updateOne(filter, update, options = {}) {
    this.#maybeFail("updateOne");

    const existing = this.docs.find((doc) => matchesFilter(doc, filter));

    if (!existing && !options.upsert) return { matchedCount: 0, modifiedCount: 0 };

    if (!existing) {
      const candidate = {
        ...literalsFrom(filter),
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      };
      this.#assertUnique(candidate, null);
      this.docs.push(candidate);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }

    // $setOnInsert is deliberately ignored on an existing document, which is
    // where the previous double diverged from Mongo most visibly.
    const candidate = { ...existing, ...(update.$set || {}) };
    this.#assertUnique(candidate, existing);
    Object.assign(existing, update.$set || {});
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    this.#maybeFail("findOneAndUpdate");
    const existing = this.docs.find((doc) => matchesFilter(doc, filter));
    if (!existing) return null;

    const before = { ...existing };
    const candidate = { ...existing, ...(update.$set || {}) };
    this.#assertUnique(candidate, existing);
    Object.assign(existing, update.$set || {});
    for (const field of Object.keys(update.$unset || {})) unsetNestedField(existing, field);
    return options.returnDocument === "after" ? { ...existing } : before;
  }

  async deleteOne(filter) {
    this.#maybeFail("deleteOne");
    const index = this.docs.findIndex((doc) => matchesFilter(doc, filter));
    if (index === -1) return { deletedCount: 0 };
    this.docs.splice(index, 1);
    return { deletedCount: 1 };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }

  find(filter = {}) {
    let results = this.docs.filter((doc) => matchesFilter(doc, filter));
    const cursor = {
      sort(spec) {
        const entries = Object.entries(spec || {});
        results = [...results].sort((left, right) => {
          for (const [field, direction] of entries) {
            const lhs = left[field];
            const rhs = right[field];
            if (lhs === rhs) continue;
            if (lhs === undefined || lhs === null) return direction === 1 ? -1 : 1;
            if (rhs === undefined || rhs === null) return direction === 1 ? 1 : -1;
            if (lhs instanceof Date && rhs instanceof Date) {
              return direction === 1 ? lhs.getTime() - rhs.getTime() : rhs.getTime() - lhs.getTime();
            }
            if (lhs < rhs) return direction === 1 ? -1 : 1;
            if (lhs > rhs) return direction === 1 ? 1 : -1;
          }
          return 0;
        });
        return cursor;
      },
      limit(count) {
        results = results.slice(0, count);
        return cursor;
      },
      async toArray() {
        return results.map((doc) => ({ ...doc }));
      },
      async *[Symbol.asyncIterator]() {
        for (const doc of results) yield { ...doc };
      },
    };
    return cursor;
  }
}

/**
 * @param {object} [options]
 * @param {Array<object>} [options.faults] write faults, e.g.
 *   `{ collection: "purchases", operation: "updateOne", remaining: 1 }`
 * @param {boolean} [options.transactions] expose a client so the indexer takes
 *   its transactional path. Sessions are a no-op here; the point is to exercise
 *   the code path, not to model isolation.
 */
export function createFakeDb({ faults = [], transactions = false } = {}) {
  const collections = new Map();

  const db = {
    faults,
    collection(name) {
      if (!collections.has(name)) {
        collections.set(name, new FakeCollection(name, REQUIRED_INDEXES[name] ?? [], faults));
      }
      return collections.get(name);
    },
    /** Test-only: raw documents for assertions. */
    dump(name) {
      return (collections.get(name)?.docs ?? []).map((doc) => ({ ...doc }));
    },
    clearFaults() {
      faults.length = 0;
    },
  };

  if (transactions) {
    db.client = {
      startSession() {
        return {
          async withTransaction(fn) {
            return fn();
          },
          async endSession() {},
        };
      },
    };
  }

  return db;
}
