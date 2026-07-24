export const PAYLOAD_SCHEMA_VERSION = 1;

const UPCASTERS = {
  workflow: {
    0: (record) => ({ ...record, schemaVersion: 1, metadata: record.metadata || {} }),
  },
  outbox: {
    0: (record) => ({ ...record, schemaVersion: 1, payload: record.payload || {} }),
  },
};

export function upcastPayload(kind, record) {
  if (!UPCASTERS[kind]) throw new TypeError(`Unknown payload kind: ${kind}`);
  if (!record || typeof record !== "object") throw new TypeError(`Invalid ${kind} payload`);
  let current = { ...record };
  let version = current.schemaVersion ?? 0;
  if (!Number.isInteger(version) || version < 0 || version > PAYLOAD_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported ${kind} schema version: ${version}`);
  }
  while (version < PAYLOAD_SCHEMA_VERSION) {
    const upcast = UPCASTERS[kind]?.[version];
    if (!upcast) throw new TypeError(`Missing ${kind} upcaster for version ${version}`);
    current = upcast(current);
    version = current.schemaVersion;
  }
  return current;
}
