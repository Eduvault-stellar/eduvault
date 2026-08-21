const MAX_COLLECTION_ITEMS = 200;

export function normalizeOrderedMaterialIds(materialIds) {
  if (!Array.isArray(materialIds)) {
    throw new TypeError("materialIds must be an array");
  }
  if (materialIds.length > MAX_COLLECTION_ITEMS) {
    throw new RangeError(`materialIds cannot contain more than ${MAX_COLLECTION_ITEMS} items`);
  }

  const ordered = [];
  const seen = new Set();

  for (const value of materialIds) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("materialIds must contain non-empty strings");
    }
    const id = value.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  return ordered;
}

export function requestedRevision(request, payload = {}) {
  const ifMatch = request.headers.get("if-match")?.trim();
  const raw = ifMatch?.replace(/^W\//, "").replace(/^"|"$/g, "") ?? payload.revision;
  const revision = Number(raw);

  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

export function revisionFilter({ id, creatorId, revision }) {
  const filter = { _id: id, creatorId };
  if (revision === 1) {
    filter.$or = [{ revision: 1 }, { revision: { $exists: false } }];
  } else {
    filter.revision = revision;
  }
  return filter;
}

export function revisionUpdatePipeline(updates, now = new Date()) {
  return [
    {
      $set: {
        ...updates,
        updatedAt: now,
        revision: { $add: [{ $ifNull: ["$revision", 1] }, 1] },
      },
    },
  ];
}
