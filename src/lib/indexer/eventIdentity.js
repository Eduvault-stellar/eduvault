import { createHash } from "node:crypto";

export function eventId(event) {
  if (event.id || event.eventId) return String(event.id || event.eventId);

  const identity = [
    event.network || event.source || "stellar",
    event.contractId || event.contract || "unknown-contract",
    event.ledger ?? event.ledgerSequence,
    event.transactionHash || event.txHash,
    event.index ?? event.eventIndex ?? event.position,
  ];

  return identity.some((part) => part === undefined || part === null || part === "")
    ? ""
    : identity.map(String).join(":");
}

export function deadLetterId(event, source = "stellar") {
  const identity = eventId(event);
  if (identity) return identity;

  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch {
    serialized = String(event);
  }
  return `${source}:unidentified:${createHash("sha256").update(serialized).digest("hex").slice(0, 32)}`;
}
