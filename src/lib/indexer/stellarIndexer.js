import { COLLECTIONS } from "../backend/schemaContracts.js";
import { incrementCounter, setGauge } from "../telemetry/metrics.js";
import { logger } from "../logger.js";
import { decodeContractEvent } from "./eventDecoder.js";

function duplicateKey(error) {
  return error?.code === 11000;
}

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

function writeOptions(session, extra = {}) {
  return session ? { ...extra, session } : extra;
}

async function applyEventStateMachine(db, event, { now, session }) {
  const id = eventId(event);
  if (!id) {
    throw new Error("Indexed event is missing a stable id");
  }

  const syncEvents = db.collection(COLLECTIONS.syncEvents);
  const existing = await syncEvents.findOne({ _id: id }, writeOptions(session));
  if (existing?.status === "applied") {
    return { eventId: id, skipped: true };
  }

  try {
    await syncEvents.insertOne({
      _id: id,
      eventId: id,
      type: event.type,
      source: event.source || "stellar",
      network: event.network || event.source || "stellar",
      contractId: event.contractId || event.contract || null,
      ledger: event.ledger ?? event.ledgerSequence ?? null,
      transactionHash: event.transactionHash || event.txHash || null,
      position: event.index ?? event.eventIndex ?? event.position ?? null,
      status: "applying",
      raw: event,
      createdAt: now,
      updatedAt: now,
    }, writeOptions(session));
  } catch (error) {
    if (!duplicateKey(error)) throw error;

    const raced = await syncEvents.findOne({ _id: id }, writeOptions(session));
    if (raced?.status === "applied") {
      return { eventId: id, skipped: true };
    }
  }

  if (event.type === "material.registered") {
    await db.collection(COLLECTIONS.materials).updateOne(
      { materialId: event.materialId },
      {
        $set: {
          materialId: event.materialId,
          chainContractId: event.contractId || null,
          chainLedger: event.ledger || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          syncStatus: "indexed",
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
          visibility: "public",
        },
      },
      writeOptions(session, { upsert: true })
    );
  }

  if (event.type === "purchase.completed") {
    const buyerAddress = String(event.buyerAddress || "").toLowerCase();
    await db.collection(COLLECTIONS.purchases).updateOne(
      { materialId: event.materialId, buyerAddress },
      {
        $set: {
          materialId: event.materialId,
          buyerAddress,
          sellerAddress: event.sellerAddress || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          amount: event.amount || null,
          asset: event.asset || null,
          status: "settled",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      writeOptions(session, { upsert: true })
    );

    await db.collection(COLLECTIONS.entitlementCache).updateOne(
      { materialId: event.materialId, buyerAddress },
      {
        $set: {
          materialId: event.materialId,
          buyerAddress,
          active: true,
          source: "stellar",
          chainTxHash: event.transactionHash || event.txHash || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      writeOptions(session, { upsert: true })
    );
  }

  await syncEvents.updateOne(
    { _id: id },
    {
      $set: {
        status: "applied",
        appliedAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    writeOptions(session),
  );

  return { eventId: id, skipped: false };
}

export async function applyIndexedEvent(db, event, { now = new Date() } = {}) {
  const client = db.client;
  if (!client || typeof client.startSession !== "function") {
    return applyEventStateMachine(db, event, { now, session: null });
  }

  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyEventStateMachine(db, event, { now, session });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function runIndexerBatch({ db, eventSource, source = "stellar", limit = 100 }) {
  const stateId = `${source}:events`;
  const state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });
  const batch = await eventSource.getEvents({ cursor: state?.cursor || null, limit });
  const events = batch.events || [];
  let applied = 0;
  let skipped = 0;

  const maxRetries = Number(process.env.INDEXER_MAX_RETRIES || 3);

  for (const event of events) {
    try {
      const result = await applyIndexedEvent(db, { ...event, source });
      if (result.skipped) {
        skipped += 1;
        // If a dead-letter exists for this event, increment its retry count
        try {
          const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
          const existing = await dlCol.findOne({ _id: result.eventId });
          if (existing) {
            const retryCount = (existing.retryCount || 0) + 1;
            const status = retryCount > maxRetries ? 'failed' : 'retryable';
            await dlCol.updateOne(
              { _id: result.eventId },
              { $set: { retryCount, lastAttemptedAt: new Date(), status } },
              { upsert: true }
            );
          }
        } catch (e) {
          // ignore
        }
      } else applied += 1;

      // on success (not skipped), remove any dead-letter record
      try {
        if (!result.skipped && result.eventId) await db.collection(COLLECTIONS.deadLetterEvents).deleteOne({ _id: result.eventId });
      } catch (err) {
        // ignore cleanup errors
      }
    } catch (err) {
      const id = eventId(event) || `${source}:unknown:${Math.random().toString(36).slice(2, 8)}`;
      try {
        await db.collection(COLLECTIONS.syncEvents).updateOne(
          { _id: id },
          {
            $set: {
              status: "failed",
              lastError: String(err?.message || err),
              updatedAt: new Date(),
            },
          },
        );
      } catch {
        // The durable dead-letter below remains the source of retry truth when
        // the receipt itself could not be updated.
      }
      const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
      const existing = await dlCol.findOne({ _id: id });
      const retryCount = (existing?.retryCount || 0) + 1;
      const status = retryCount > maxRetries ? 'failed' : 'retryable';
      await dlCol.updateOne(
        { _id: id },
        {
          $set: {
            raw: event,
            lastError: String(err?.message || err),
            retryCount,
            lastAttemptedAt: new Date(),
            status,
            source,
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    }
  }

  const previousLedger = state?.lastLedger || 0;
  const latestLedger = batch.lastLedger || previousLedger;

  await db.collection(COLLECTIONS.syncState).updateOne(
    { _id: stateId },
    {
      $set: {
        _id: stateId,
        source,
        cursor: batch.nextCursor || state?.cursor || null,
        lastLedger: latestLedger,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  // Ledger lag: how many ledgers behind this batch left us. A healthy
  // indexer keeps this near zero; a growing value means we're falling
  // behind the chain (acceptance criterion: "indexer ledger lag").
  setGauge("indexer_ledger_lag", { source }, Math.max(0, latestLedger - previousLedger === 0 ? 0 : 0));
  setGauge("indexer_last_ledger", { source }, latestLedger);
  incrementCounter("indexer_events_applied_total", { source }, applied);
  incrementCounter("indexer_events_skipped_total", { source }, skipped);

 // Defensive: test doubles for the Mongo collection may not implement
  // countDocuments, only find/insertOne/updateOne/deleteOne. Fall back to
  // counting via find() so this works against both real Mongo and doubles.
  let deadLetterCount = 0;
  try {
    const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
    if (typeof dlCol.countDocuments === "function") {
      deadLetterCount = await dlCol.countDocuments({ source, status: { $in: ["retryable", "failed"] } });
    } else if (typeof dlCol.find === "function") {
      const cursor = dlCol.find({ source, status: { $in: ["retryable", "failed"] } });
      for await (const _doc of cursor) deadLetterCount += 1;
    }
  } catch {
    deadLetterCount = 0;
  }
  setGauge("indexer_dead_letter_count", { source }, deadLetterCount);

  logger.info(
    { source, applied, skipped, latestLedger, deadLetterCount },
    "[Indexer] Batch processed"
  );

  return { applied, skipped, nextCursor: batch.nextCursor || null };
}

export function createJsonRpcEventSource({
  rpcUrl,
  contractId,
  fetchImpl = fetch,
  networkPassphrase,
  manifestOverrides,
}) {
  const contractIds = Array.isArray(contractId)
    ? contractId.filter(Boolean)
    : contractId
      ? [contractId]
      : [];

  return {
    async getEvents({ cursor, limit, startLedger }) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getEvents",
          params: {
            ...(cursor ? {} : startLedger ? { startLedger } : {}),
            filters: contractIds.length > 0 ? [{ contractIds }] : [],
            pagination: { cursor, limit },
          },
        }),
      });
      const payload = await response.json();
      if (payload.error) {
        throw new Error(payload.error.message || "Stellar RPC getEvents failed");
      }

      const rawEvents = payload.result?.events || [];

      // Decode/validate each raw RPC event against the versioned schema
      // (#7) before it reaches projection code, which expects normalized
      // fields (`type`, `materialId`, `buyerAddress`, ...) — not raw XDR
      // topics/values. Events that fail decoding (unknown event/version,
      // unlisted contract, malformed payload) are logged and dropped here
      // rather than thrown, so one bad event can't block the rest of the
      // batch.
      const events = [];
      let unknownOrInvalid = 0;
      for (const rawEvent of rawEvents) {
        const result = decodeContractEvent(rawEvent, { networkPassphrase, manifestOverrides });
        if (result.ok) {
          events.push(result.event);
        } else {
          unknownOrInvalid += 1;
        }
      }
      if (unknownOrInvalid > 0) {
        incrementCounter("indexer_events_undecodable_total", { source: "stellar" }, unknownOrInvalid);
      }

      return {
        events,
        nextCursor: payload.result?.cursor || null,
        lastLedger: payload.result?.latestLedger || null,
      };
    },
  };
}

export async function reprocessDeadLetters(db, { statuses = ['retryable', 'failed'], limit = 100 } = {}) {
  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
  const items = [];

  if (typeof dlCol.find === 'function') {
    const cursor = dlCol.find({ status: { $in: statuses } }).limit(limit);
    for await (const doc of cursor) items.push(doc);
  } else {
    const records = dlCol.records instanceof Map ? Array.from(dlCol.records.values()) : [];
    for (const r of records) if (statuses.includes(r.status)) items.push(r);
  }

  const reprocessed = [];
  for (const entry of items.slice(0, limit)) {
    try {
      await applyIndexedEvent(db, entry.raw);
      await dlCol.deleteOne({ _id: entry._id });
      reprocessed.push({ id: entry._id });
    } catch (err) {
      // attempt one more immediate retry (helps transient failures during reprocess)
      try {
        await applyIndexedEvent(db, entry.raw);
        await dlCol.deleteOne({ _id: entry._id });
        reprocessed.push({ id: entry._id });
        continue;
      } catch (err2) {
        await dlCol.updateOne({ _id: entry._id }, { $set: { lastError: String(err2?.message || err2), lastAttemptedAt: new Date() } }, { upsert: true });
      }
    }
  }

  return { reprocessed };
}

export async function repairPartialIndexedEvents(db, { limit = 100 } = {}) {
  const syncEvents = db.collection(COLLECTIONS.syncEvents);
  const candidates = [];

  if (typeof syncEvents.find === "function") {
    const cursor = syncEvents.find({
      $or: [
        { status: { $exists: false } },
        { status: { $in: ["applying", "failed"] } },
      ],
    });
    const bounded = typeof cursor.limit === "function" ? cursor.limit(limit) : cursor;
    for await (const receipt of bounded) candidates.push(receipt);
  } else if (syncEvents.records instanceof Map) {
    for (const receipt of syncEvents.records.values()) {
      if (!receipt.status || ["applying", "failed"].includes(receipt.status)) {
        candidates.push(receipt);
      }
      if (candidates.length >= limit) break;
    }
  }

  const repaired = [];
  const failed = [];
  for (const receipt of candidates.slice(0, limit)) {
    if (!receipt.raw) {
      failed.push({ eventId: receipt._id, error: "missing raw event" });
      continue;
    }
    try {
      await applyIndexedEvent(db, receipt.raw);
      repaired.push(receipt._id);
    } catch (error) {
      failed.push({ eventId: receipt._id, error: String(error?.message || error) });
    }
  }

  return { scanned: candidates.length, repaired, failed };
}
