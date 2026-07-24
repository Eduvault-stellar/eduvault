import { Redis } from 'ioredis';
import { CACHE_REGISTRY, CacheEnvelope } from './registry';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const activeFlights = new Map<string, Promise<any>>();

export class CacheEngine {
  // Generates highly structured, safe keys
  public static buildKey(
    registryKey: keyof typeof CACHE_REGISTRY,
    dims: { tenant: string; network: string; authScope: string; id: string }
  ): string {
    const config = CACHE_REGISTRY[registryKey];
    return config.keySchema
      .replace('{tenant}', dims.tenant)
      .replace('{network}', dims.network)
      .replace('{authScope}', dims.authScope)
      .replace('{userId}', dims.id)
      .replace('{materialId}', dims.id);
  }

  // Safe wrapper that fetches from cache or loads from database without stampedes
  public static async getOrSet<T>(
    registryKey: keyof typeof CACHE_REGISTRY,
    key: string,
    fallbackFetcher: () => Promise<T | null>,
    currentSystemVersion: number
  ): Promise<T | null> {
    const config = CACHE_REGISTRY[registryKey];

    try {
      const cached = await redis.get(key);
      if (cached) {
        const envelope: CacheEnvelope<T> = JSON.parse(cached);
        const versionDrift = currentSystemVersion - envelope.version;

        // Bounded Staleness Check
        if (versionDrift <= config.boundedStalenessDelta) {
          if (envelope.isNegative) return null;
          return envelope.data;
        }
      }
    } catch (error) {
      if (config.failPolicy === 'FAIL_CLOSED') {
        throw new Error(`Cache error on security-sensitive path: ${key}. Access locked.`);
      }
    }

    // Single-Flight: Coalesces identical concurrent requests
    if (activeFlights.has(key)) {
      return activeFlights.get(key);
    }

    const flight = (async () => {
      try {
        const freshData = await fallbackFetcher();
        const envelope: CacheEnvelope<T> = {
          data: freshData,
          version: currentSystemVersion,
          timestamp: Date.now(),
          isNegative: freshData === null
        };

        const ttl = freshData === null ? config.negativeTtl : config.ttl;
        await redis.set(key, JSON.stringify(envelope), 'EX', ttl);
        return freshData;
      } catch (error) {
        if (config.failPolicy === 'FAIL_CLOSED') throw error;
        return null;
      } finally {
        activeFlights.delete(key);
      }
    })();

    activeFlights.set(key, flight);
    return flight;
  }
}
