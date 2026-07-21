import { client } from './backend/db'; // Your app's MongoDB client instance
import { CacheEngine } from './cache/engine';

export async function updateEntitlement(tenant, network, userId, authScope, updates) {
  const db = client.db();
  const session = client.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      // 1. Update source of truth
      result = await db.collection('entitlements').findOneAndUpdate(
        { tenant, network, userId, authScope },
        { 
          $set: { ...updates, updatedAt: new Date() },
          $inc: { version: 1 } 
        },
        { returnDocument: 'after', session }
      );

      const targetCacheKey = CacheEngine.buildKey('entitlements', {
        tenant, network, authScope, id: userId
      });

      // 2. Queue the invalidation to the transactional outbox
      await db.collection('cache_outbox').insertOne({
        eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        cacheKey: targetCacheKey,
        targetRegistry: 'entitlements',
        status: 'PENDING',
        createdAt: new Date(),
        attempts: 0
      }, { session });
    });

    return result.value;
  } finally {
    await session.endSession();
  }
