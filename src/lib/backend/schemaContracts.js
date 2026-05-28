export const COLLECTIONS = {
  users: "users",
  materials: "materials",
  purchases: "purchases",
  entitlementCache: "entitlement_cache",
  syncState: "sync_state",
  syncEvents: "sync_events",
  deadLetterEvents: "dead_letter_events",
  materialHistory: "material_history",
};

export const REQUIRED_INDEXES = {
  users: [
    { keys: { email: 1 }, options: { unique: true } },
    { keys: { walletAddressLower: 1 }, options: { sparse: true } },
  ],
  materials: [
    { keys: { userAddress: 1, createdAt: -1 } },
    { keys: { visibility: 1, createdAt: -1 } },
    { keys: { materialId: 1 }, options: { sparse: true } },
    { keys: { updatedAt: -1 } },
  ],
  purchases: [
    { keys: { buyerAddress: 1, createdAt: -1 } },
    { keys: { materialId: 1, buyerAddress: 1 }, options: { unique: true, sparse: true } },
    { keys: { chainTxHash: 1 }, options: { unique: true, sparse: true } },
  ],
  entitlement_cache: [
    { keys: { buyerAddress: 1, materialId: 1 }, options: { unique: true } },
    { keys: { active: 1, updatedAt: -1 } },
  ],
  sync_state: [{ keys: { source: 1 }, options: { unique: true } }],
  sync_events: [{ keys: { _id: 1 }, options: { unique: true } }],
  dead_letter_events: [
    { keys: { _id: 1 }, options: { unique: true } },
    { keys: { status: 1 } },
    { keys: { retryCount: 1 } },
  ],
  material_history: [
    { keys: { materialId: 1, updatedAt: -1 } },
    { keys: { updatedBy: 1 } },
  ],
};

export function applyTimestamps(record, now = new Date()) {
  const timestamp = now instanceof Date ? now : new Date(now);
  return {
    ...record,
    createdAt: record.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

export const EDITABLE_MATERIAL_FIELDS = [
  "title",
  "description",
  "price",
  "usageRights",
  "visibility",
  "thumbnailUrl",
];

export const IMMUTABLE_MATERIAL_FIELDS = [
  "storageKey",
  "userAddress",
  "materialId",
  "createdAt",
];

export function buildMaterialHistoryEntry({ materialId, previousDoc, update, updatedBy, changeReason, source }) {
  const changes = {};
  for (const key of EDITABLE_MATERIAL_FIELDS) {
    if (key in update && update[key] !== previousDoc?.[key]) {
      changes[key] = { from: previousDoc?.[key], to: update[key] };
    }
  }
  return {
    materialId,
    changes,
    updatedBy,
    updatedAt: new Date(),
    changeReason: changeReason || null,
    source: source || "creator",
  };
}
