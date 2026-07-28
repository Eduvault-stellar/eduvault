import { createClient } from 'redis';
import { createCircuitBreaker, CircuitState, DependencyError } from "@/lib/resilience/index.js";
import { withTimeout } from "@/lib/resilience/timeout.js";
import { withRetry } from "@/lib/resilience/retry.js";
import { setGauge, incrementCounter } from "@/lib/telemetry/metrics";

const REDIS_TIMEOUT_MS = Number(process.env.REDIS_TIMEOUT_MS || 5000);
const REDIS_CONNECT_TIMEOUT_MS = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000);

const redisCircuitBreaker = createCircuitBreaker("redis", {
  failureThreshold: Number(process.env.REDIS_CB_FAILURE_THRESHOLD || 3),
  successThreshold: 2,
  resetTimeoutMs: Number(process.env.REDIS_CB_RESET_TIMEOUT_MS || 30000),
  onStateChange(name, from, to) {
    setGauge("circuit_breaker_state", { dependency: name, state: to }, 1);
    if (from && from !== to) {
      setGauge("circuit_breaker_state", { dependency: name, state: from }, 0);
    }
    if (to === CircuitState.OPEN) {
      incrementCounter("circuit_breaker_open_total", { dependency: name });
    }
    const level = to === CircuitState.OPEN ? "warn" : "info";
    console[level](`[circuit-breaker] redis: ${from} -> ${to}`);
  },
});

export function getRedisCircuitBreakerState() {
  return redisCircuitBreaker.getState();
}

let client = null;

export async function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (redisCircuitBreaker.getState() === CircuitState.OPEN) {
    throw new DependencyError({
      dependency: "redis",
      action: "connect",
      retryable: false,
      statusCode: 503,
      userMessage: "Cache service is temporarily unavailable.",
    });
  }
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
    client.on('error', (err) => console.error('Redis error', err.message));
    await withTimeout(client.connect(), REDIS_CONNECT_TIMEOUT_MS, 'redis.connect');
  }
  return client;
}

export async function cacheGet(key) {
  return redisCircuitBreaker.call(async () => {
    const redis = await getRedisClient();
    if (!redis) return null;
    return withRetry(
      async () => {
        const val = await withTimeout(redis.get(key), REDIS_TIMEOUT_MS, 'redis.get');
        return val ? JSON.parse(val) : null;
      },
      { idempotent: true, maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 1000 }
    );
  });
}

export async function cacheSet(key, value, ttlSeconds = 600) {
  return redisCircuitBreaker.call(async () => {
    const redis = await getRedisClient();
    if (!redis) return;
    await withTimeout(redis.set(key, JSON.stringify(value), { EX: ttlSeconds }), REDIS_TIMEOUT_MS, 'redis.set');
  });
}

export async function cacheDel(key) {
  return redisCircuitBreaker.call(async () => {
    const redis = await getRedisClient();
    if (!redis) return;
    await withTimeout(redis.del(key), REDIS_TIMEOUT_MS, 'redis.del');
  });
}
