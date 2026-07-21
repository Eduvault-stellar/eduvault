export interface CacheConfig {
  sourceOfTruth: 'MongoDB' | 'SmartContract';
  keySchema: string;
  ttl: number;
  negativeTtl: number;
  failPolicy: 'FAIL_OPEN' | 'FAIL_CLOSED';
  securitySensitive: boolean;
  boundedStalenessDelta: number; 
}

export const CACHE_REGISTRY: Record<string, CacheConfig> = {
  entitlements: {
    sourceOfTruth: 'MongoDB',
    keySchema: 'ent:v1:{tenant}:{network}:{authScope}:{userId}',
    ttl: 300,
    negativeTtl: 30,
    failPolicy: 'FAIL_CLOSED', // Blocks access if cache fails
    securitySensitive: true,
    boundedStalenessDelta: 0, // Strict, immediate correctness
  },
  materials: {
    sourceOfTruth: 'MongoDB',
    keySchema: 'mat:v1:{tenant}:{network}:public:{materialId}',
    ttl: 3600,
    negativeTtl: 60,
    failPolicy: 'FAIL_OPEN', // Uses stale data if backend breaks
    securitySensitive: false,
    boundedStalenessDelta: 3, // Allowed to be up to 3 versions behind
  }
};

export interface CacheEnvelope<T> {
  data: T | null;
  version: number;
  timestamp: number;
  isNegative: boolean;
  }
