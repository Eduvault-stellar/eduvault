import { Networks } from "@stellar/stellar-sdk";
import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource } from "../src/lib/indexer/stellarIndexer.js";
import { applyEscrowEvent } from "../src/lib/indexer/escrowIndexer.js";
import { reconcileEscrowOperations } from "../src/lib/escrow/escrowOperations.js";

const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
const networkPassphrase =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET") === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const contractId = process.env.TRUSTLESS_WORK_CONTRACT_ID_TESTNET || process.env.NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID;

if (!rpcUrl) {
  throw new Error("NEXT_PUBLIC_STELLAR_RPC_URL is required to run the indexer");
}
if (!contractId) {
  throw new Error("TRUSTLESS_WORK_CONTRACT_ID_TESTNET or NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID is required to run the escrow indexer");
}

const mode = process.argv[2] === "reconcile" ? "reconcile" : "replay";
const startLedger = parseInt(mode === "reconcile" ? process.argv[3] : process.argv[2], 10);
const limit = parseInt(mode === "reconcile" ? process.argv[4] : process.argv[3], 10) || 100;
const actor = process.env.ESCROW_REPLAY_ACTOR || process.env.USER || "admin-cli";

if (!startLedger || isNaN(startLedger)) {
  console.error("Usage: node scripts/replay-escrow.mjs <startLedger> [limit]");
  console.error("   or: node scripts/replay-escrow.mjs reconcile <startLedger> [limit]");
  process.exit(1);
}

const db = await getDb();
const eventSource = createJsonRpcEventSource({ rpcUrl, contractId, networkPassphrase });

function matchesOperation(event, operation) {
  if (operation.transactionHash && (event.transactionHash === operation.transactionHash || event.txHash === operation.transactionHash)) {
    return true;
  }
  if (operation.payload?.escrowId && event.escrowId === operation.payload.escrowId) {
    return true;
  }
  return false;
}

try {
  if (mode === "reconcile") {
    console.log(`Reconciling escrow operations from ledger ${startLedger} with event limit ${limit}`);
    const batch = await eventSource.getEvents({ startLedger, limit });
    const events = batch.events || [];
    const result = await reconcileEscrowOperations(db, {
      actor,
      limit,
      queryChainState: async (operation) => {
        const event = events.find((candidate) => matchesOperation(candidate, operation));
        if (!event) return { found: false, reason: "no matching escrow event found" };
        return {
          found: true,
          confirmed: true,
          transactionHash: event.transactionHash || event.txHash || operation.transactionHash || null,
          ledgerSequence: event.ledger ?? event.ledgerSequence ?? operation.ledgerSequence ?? null,
          event,
        };
      },
      project: async (operation) => {
        const event = operation.onChainState?.event;
        if (!event) throw new Error("missing on-chain event for escrow projection");
        await applyEscrowEvent(db, { ...event, source: "escrow" });
      },
    });
    console.log(JSON.stringify({ mode, actor, ...result }, null, 2));
  } else {
    console.log(`Replaying escrow events from ledger ${startLedger} with limit ${limit}`);
    const batch = await eventSource.getEvents({ startLedger, limit });
    const events = batch.events || [];

    console.log(`Found ${events.length} events to replay.`);

    let applied = 0;
    let skipped = 0;

    for (const event of events) {
      const result = await applyEscrowEvent(db, { ...event, source: "escrow" });
      if (result.skipped) skipped += 1;
      else applied += 1;
    }

    console.log(`Replay complete. Applied: ${applied}, Skipped: ${skipped}`);
  }
} catch (err) {
  console.error(`${mode === "reconcile" ? "Reconcile" : "Replay"} failed:`, err);
}

process.exit(0);
