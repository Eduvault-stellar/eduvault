import { CacheEngine } from '../engine';
import { CACHE_REGISTRY } from '../registry';
import { updateEntitlement } from '../../entitlement';
import { Redis } from 'ioredis';
import { client } from '../../backend/db';

// Mock Dependencies cleanly
jest.mock('ioredis');
jest.mock('../../backend/db', () => ({
  client: {
    db: jest.fn(() => ({
      collection: jest.fn(() => ({
        findOneAndUpdate: jest.fn(),
        insertOne: jest.fn(),
        findOne: jest.fn()
      }))
    })),
    startSession: jest.fn(() => ({
      withTransaction: jest.fn((cb) => cb()),
      endSession: jest.fn()
    }))
  }
}));

describe('Robust Caching & Durable Invalidation System', () => {
  let mockRedis: any;
  let mockDb: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = new Redis();
    mockDb = client.db();
  });

  // Test 1: Cache Stampede / Coalescing (Single-Flight)
  it('should coalesce concurrent misses into a single flight operation to prevent stampedes', async () => {
    mockRedis.get.mockResolvedValue(null); // Force a cache miss
    mockRedis.set.mockResolvedValue('OK');

    const slowFetcher = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: 'mat-123', price: 100 };
    });

    const key = 'mat:v1:tenantA:mainnet:public:mat-123';
    
    // Fire off 3 requests concurrently
    const results = await Promise.all([
      CacheEngine.getOrSet('materials', key, slowFetcher, 1),
      CacheEngine.getOrSet('materials', key, slowFetcher, 1),
      CacheEngine.getOrSet('materials', key, slowFetcher, 1)
    ]);

    // Affirm database fetcher ran EXACTLY once despite 3 incoming queries
    expect(slowFetcher).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ id: 'mat-123', price: 100 });
    expect(results[1]).toEqual({ id: 'mat-123', price: 100 });
  });

  // Test 2: Bounded Staleness Constraints
  it('should reject cached values and force a reload if version drift violates bounded staleness constraints', async () => {
    const expiredEnvelope = {
      data: { id: 'mat-123', content: 'stale' },
      version: 1, // System version is now 5, drift = 4 (Limit is 3)
      timestamp: Date.now(),
      isNegative: false
    };

    mockRedis.get.mockResolvedValue(JSON.stringify(expiredEnvelope));
    
    const continuousFetcher = jest.fn().mockResolvedValue({ id: 'mat-123', content: 'fresh' });
    const key = 'mat:v1:tenantA:mainnet:public:mat-123';

    const result = await CacheEngine.getOrSet('materials', key, continuousFetcher, 5);

    // Should bypass the cache because drift (4) > boundedStalenessDelta (3)
    expect(continuousFetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'mat-123', content: 'fresh' });
  });

  // Test 3: Transactional Outbox Isolation (Atomic Safety)
  it('should securely register an invalidation row inside the same database transactional scope', async () => {
    const mockFindOneAndUpdate = jest.fn().mockResolvedValue({ value: { updated: true } });
    const mockInsertOne = jest.fn().mockResolvedValue({ insertedId: 'ok' });

    mockDb.collection.mockImplementation((name: string) => {
      if (name === 'entitlements') return { findOneAndUpdate: mockFindOneAndUpdate };
      if (name === 'cache_outbox') return { insertOne: mockInsertOne };
      return {};
    });

    await updateEntitlement('tenantA', 'mainnet', 'user-99', 'admin', { active: false });

    // Assert both events happened and respected atomic transaction parameters
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
    expect(mockInsertOne).toHaveBeenCalled();
    expect(mockInsertOne.mock.calls[0][0].status).toBe('PENDING');
    expect(mockInsertOne.mock.calls[0][0].cacheKey).toContain('ent:v1:tenantA:mainnet:admin:user-99');
  });

  // Test 4: Security-Sensitive Failures (Fail-Closed Policy)
  it('should immediately fail closed and block operations if an exception hits security-sensitive cache paths', async () => {
    // Simulate Redis cluster outage throwing an execution exception
    mockRedis.get.mockRejectedValue(new Error('Redis connection lost'));

    const key = 'ent:v1:tenantA:mainnet:admin:user-99';
    const databaseBackupCall = jest.fn();

    // Verify it drops safely into an explicit validation crash instead of defaulting to dirty data
    await expect(
      CacheEngine.getOrSet('entitlements', key, databaseBackupCall, 1)
    ).rejects.toThrow('Cache error on security-sensitive path');
    
    expect(databaseBackupCall).not.toHaveBeenCalled();
  });

  // Test 5: Poison-Resistant Negative Caching
  it('should safely remember negative lookups (null values) without triggering unnecessary backend sweeps', async () => {
    const negativeEnvelope = {
      data: null,
      version: 1,
      timestamp: Date.now(),
      isNegative: true
    };

    mockRedis.get.mockResolvedValue(JSON.stringify(negativeEnvelope));
    const databaseCall = jest.fn();

    const key = 'mat:v1:tenantA:mainnet:public:missing-id';
    const result = await CacheEngine.getOrSet('materials', key, databaseCall, 1);

    expect(result).toBeNull();
    expect(databaseCall).not.toHaveBeenCalled();
  });
});
                               
