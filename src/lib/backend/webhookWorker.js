import { getDb } from '@/lib/mongodb';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';
import { dispatchWebhook, sanitizeDispatchError } from '@/lib/webhooks/dispatcher';
import { generateSignaturesHeader, getActiveSecrets } from '@/lib/webhooks/signature';
import { logger } from '@/lib/logger';
import { incrementCounter } from '@/lib/telemetry/metrics';

const CONFIG = {
  pollingInterval: 10000,
  maxConcurrentJobs: 10,
  maxRetries: 5,
};

function calculateBackoff(attempt) {
  // Exponential backoff: 2s, 4s, 8s, 16s, 32s + jitter
  const baseDelay = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return baseDelay + jitter;
}

export async function processWebhookDeliveries() {
  try {
    const db = await getDb();
    const deliveriesCollection = db.collection(COLLECTIONS.webhookDeliveries);
    const webhooksCollection = db.collection(COLLECTIONS.webhooks);

    const pendingDeliveries = await deliveriesCollection
      .find({
        status: 'pending',
        nextAttemptAt: { $lte: new Date() },
      })
      .sort({ createdAt: 1 }) // Process oldest first to try to maintain ordering
      .limit(CONFIG.maxConcurrentJobs)
      .toArray();

    if (pendingDeliveries.length === 0) return 0;

    logger.info(`[Webhook Worker] Processing ${pendingDeliveries.length} deliveries`);

    const promises = pendingDeliveries.map(async (delivery) => {
      const attemptRecord = {
        timestamp: new Date(),
        attemptNumber: (delivery.attempts?.length || 0) + 1,
      };

      try {
        const webhook = await webhooksCollection.findOne({ _id: delivery.webhookId });

        if (!webhook || webhook.status !== 'active') {
          // Webhook deleted or disabled
          await deliveriesCollection.updateOne(
            { _id: delivery._id },
            { $set: { status: 'failed', updatedAt: new Date() } }
          );
          return;
        }

        const activeSecrets = getActiveSecrets(webhook.secrets || []);
        const payloadStr = JSON.stringify(delivery.payload);
        const signatureHeader = activeSecrets.length > 0
          ? generateSignaturesHeader(payloadStr, activeSecrets)
          : null;

        const start = Date.now();
        // The dispatcher only returns a redacted, bounded and digested view of
        // the subscriber response, so the record below can be persisted and
        // served back to the webhook owner as-is (#173).
        const response = await dispatchWebhook(webhook.url, payloadStr, signatureHeader);
        attemptRecord.duration = Date.now() - start;
        attemptRecord.responseStatus = response.responseStatus ?? response.status ?? null;
        attemptRecord.responseHeaders = response.responseHeaders || {};
        attemptRecord.responseBody = response.responseBody || '';
        attemptRecord.responseBodyDigest = response.responseBodyDigest ?? null;
        attemptRecord.responseBodyBytes = response.responseBodyBytes ?? 0;
        attemptRecord.responseBodyTruncated = Boolean(response.responseBodyTruncated);
        if (response.responseBodyOmittedReason) {
          attemptRecord.responseBodyOmittedReason = response.responseBodyOmittedReason;
        }

        incrementCounter('webhook_response_captured_total', {
          truncated: String(attemptRecord.responseBodyTruncated),
          omitted: attemptRecord.responseBodyOmittedReason || 'none',
        });

        if (attemptRecord.responseStatus >= 200 && attemptRecord.responseStatus < 300) {
          // Success
          await deliveriesCollection.updateOne(
            { _id: delivery._id },
            { 
              $set: { status: 'success', updatedAt: new Date() },
              $push: { attempts: attemptRecord }
            }
          );
          logger.info(
            `[Webhook Worker] Delivery ${delivery._id} successful (status=${attemptRecord.responseStatus} bytes=${attemptRecord.responseBodyBytes} digest=${attemptRecord.responseBodyDigest || 'none'})`
          );
        } else {
          // HTTP Error
          attemptRecord.error = `HTTP ${attemptRecord.responseStatus}`;
          await handleFailure(deliveriesCollection, delivery, attemptRecord);
        }
      } catch (error) {
        // Dispatch, signing or storage error. The message can embed the
        // endpoint URL, its resolved address or upstream text, so it is
        // redacted before it is persisted or logged.
        attemptRecord.error = sanitizeDispatchError(error);
        logger.warn(
          `[Webhook Worker] Delivery ${delivery._id} attempt ${attemptRecord.attemptNumber} failed: ${attemptRecord.error}`
        );
        try {
          await handleFailure(deliveriesCollection, delivery, attemptRecord);
        } catch (persistError) {
          // The delivery stays pending and is retried on the next poll.
          logger.error(
            `[Webhook Worker] Could not record failure for delivery ${delivery._id}: ${sanitizeDispatchError(persistError)}`
          );
        }
      }
    });

    await Promise.allSettled(promises);
    return pendingDeliveries.length;
  } catch (error) {
    logger.error(`[Webhook Worker] Error in main loop: ${error.message}`);
    return 0;
  }
}

async function handleFailure(collection, delivery, attemptRecord) {
  const isFinalAttempt = attemptRecord.attemptNumber >= CONFIG.maxRetries;
  const updateDoc = {
    $push: { attempts: attemptRecord },
    $set: { updatedAt: new Date() }
  };

  if (isFinalAttempt) {
    updateDoc.$set.status = 'dead_letter';
    updateDoc.$set.nextAttemptAt = null;
    logger.warn(
      `[Webhook Worker] Delivery ${delivery._id} moved to dead_letter (lastError=${attemptRecord.error || 'unknown'})`
    );
  } else {
    const delay = calculateBackoff(attemptRecord.attemptNumber);
    updateDoc.$set.nextAttemptAt = new Date(Date.now() + delay);
  }

  await collection.updateOne({ _id: delivery._id }, updateDoc);
}

export async function runWebhookWorker() {
  logger.info("[Webhook Worker] Starting...");
  while (true) {
    const processed = await processWebhookDeliveries();
    if (processed === 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.pollingInterval));
    }
  }
}

if (process.env.RUN_WEBHOOK_WORKER === "true") {
  runWebhookWorker().catch((error) => {
    logger.error("[Webhook Worker] Fatal error:", error);
    process.exit(1);
  });
}
