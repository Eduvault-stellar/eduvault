import { getDb } from "@/lib/mongodb";
import { pollOutbox, completeOutboxEvent, failOutboxEvent, OUTBOX_EVENT_TYPES } from "@/lib/outbox";
import { broadcastPurchaseEvent } from "@/lib/webhooks/sender";

export async function processOutboxEvents() {
  const db = await getDb();
  const events = await pollOutbox(db, 10, 30000);

  if (events.length === 0) return 0;

  console.log(`[Outbox Worker] Processing ${events.length} events...`);

  for (const event of events) {
    try {
      if (event.type === OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK) {
        // broadcastPurchaseEvent is already handling the payload correctly
        // However, we need to ensure it's idempotent. Our implementation inside
        // broadcastPurchaseEvent loops over URLs and sends them. We will await it.
        // The sender internally uses Promise.allSettled but doesn't await the outer.
        // To properly fail if webhook sending crashes, we should await the broadcasting.
        // In this architecture, we consider the outbox event successfully dispatched
        // if broadcastPurchaseEvent executes without throwing an unhandled exception.
        
        await broadcastPurchaseEvent(event.payload.materialId, event.payload);
      } else {
        console.warn(`[Outbox Worker] Unknown event type: ${event.type}`);
      }

      // Mark completed
      await completeOutboxEvent(db, event._id);
      console.log(`[Outbox Worker] Completed event ${event._id} of type ${event.type}`);
    } catch (error) {
      console.error(`[Outbox Worker] Error processing event ${event._id}:`, error);
      await failOutboxEvent(db, event._id, error.message);
    }
  }

  return events.length;
}
