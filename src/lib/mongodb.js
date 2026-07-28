import { cpus } from "node:os";
import { MongoClient } from "mongodb";
import { ensureChallengeIndexes } from "./auth/challenge.js";
import { updatePressureSignal } from "./capacity/shed.js";
import { createCircuitBreaker, CircuitState, DependencyError } from "@/lib/resilience/index.js";
import { withTimeout } from "@/lib/resilience/timeout.js";
import { setGauge, incrementCounter } from "@/lib/telemetry/metrics.js";

const globalForMongo = globalThis;

const mongoCircuitBreaker = createCircuitBreaker("mongodb", {
  failureThreshold: Number(process.env.MONGODB_CB_FAILURE_THRESHOLD || 3),
  successThreshold: 2,
  resetTimeoutMs: Number(process.env.MONGODB_CB_RESET_TIMEOUT_MS || 30000),
  onStateChange(name, from, to) {
    setGauge("circuit_breaker_state", { dependency: name, state: to }, 1);
    if (from && from !== to) {
      setGauge("circuit_breaker_state", { dependency: name, state: from }, 0);
    }
    if (to === CircuitState.OPEN) {
      incrementCounter("circuit_breaker_open_total", { dependency: name });
    }
    const level = to === CircuitState.OPEN ? "warn" : "info";
    console[level](
      `[circuit-breaker] mongodb: ${from} -> ${to}`,
    );
  },
});


function parsePositiveInteger(value, fallback, variableName) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${variableName} must be a non-negative integer; received "${value}"`);
  }

  return parsed;
}

function getMongoConfiguration() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }

  const cpuCount = Math.max(cpus().length, 1);
  const maxPoolSize = parsePositiveInteger(
    process.env.MONGODB_MAX_POOL_SIZE,
    cpuCount * 5,
    "MONGODB_MAX_POOL_SIZE",
  );
  const minPoolSize = parsePositiveInteger(
    process.env.MONGODB_MIN_POOL_SIZE,
    Math.min(cpuCount, maxPoolSize),
    "MONGODB_MIN_POOL_SIZE",
  );

  if (minPoolSize > maxPoolSize) {
    throw new Error("MONGODB_MIN_POOL_SIZE cannot be greater than MONGODB_MAX_POOL_SIZE");
  }

  return {
    uri,
    dbName: process.env.MONGODB_DB || "eduvault",
    clientOptions: {
      maxPoolSize,
      minPoolSize,
      serverSelectionTimeoutMS: parsePositiveInteger(
        process.env.MONGODB_TIMEOUT_MS,
        5000,
        "MONGODB_TIMEOUT_MS",
      ),
      heartbeatFrequencyMS: parsePositiveInteger(
        process.env.MONGODB_HEARTBEAT_MS,
        10000,
        "MONGODB_HEARTBEAT_MS",
      ),
      maxIdleTimeMS: parsePositiveInteger(
        process.env.MONGODB_MAX_IDLE_TIME_MS,
        30000,
        "MONGODB_MAX_IDLE_TIME_MS",
      ),
      retryReads: true,
      retryWrites: true,
    },
  };
}

export function getMongoCircuitBreakerState() {
  return mongoCircuitBreaker.getState();
}

export function getMongoClientPromise() {
  if (mongoCircuitBreaker.getState() === CircuitState.OPEN) {
    throw new DependencyError({
      dependency: "mongodb",
      action: "connect",
      retryable: true,
      userMessage: "The database is temporarily unavailable. Please try again later.",
    });
  }

  if (!globalForMongo._mongoClientPromise) {
    const { uri, clientOptions } = getMongoConfiguration();
    const client = new MongoClient(uri, clientOptions);

    globalForMongo._mongoClient = client;

    try {
      client.on("connectionPoolCreated", () => {
        updatePressureSignal("mongoPoolCreated", true);
      });

      client.on("connectionPoolClosed", () => {
        updatePressureSignal("mongoPoolExhausted", false);
      });
    } catch {
      // Event monitoring is not available in all MongoDB driver environments.
    }

    globalForMongo._mongoClientPromise = client.connect().then(
      (resolvedClient) => {
        mongoCircuitBreaker.recordSuccess();
        return resolvedClient;
      },
      (error) => {
        globalForMongo._mongoClient = null;
        globalForMongo._mongoClientPromise = null;
        updatePressureSignal("mongoPoolExhausted", true);
        mongoCircuitBreaker.recordFailure();

        console.error("[mongodb] Connection failed", {
          name: error?.name,
          code: error?.code,
          codeName: error?.codeName,
          message: error?.message,
        });

        throw error;
      },
    );
  }

  return globalForMongo._mongoClientPromise;
}

export async function getMongoClient() {
  return getMongoClientPromise();
}

export async function getDb() {
  const client = await getMongoClientPromise();
  const { dbName } = getMongoConfiguration();

  return client.db(dbName);
}

export default async function connectToDatabase() {
  const client = await getMongoClientPromise();
  const { dbName } = getMongoConfiguration();

  return {
    client,
    db: client.db(dbName),
  };
}

export async function ensureMongoIndexes() {
  const db = await getDb();
  const collection = db.collection("materials");

  await collection.createIndex(
    { category: 1, price: 1, title: 1, description: 1 },
    { name: "materials_search_compound_idx", background: true },
  );
  await ensureChallengeIndexes(db);
}

export async function pingDatabase() {
  const db = await getDb();
  await withTimeout(db.command({ ping: 1 }), 5000, "mongodb.ping");
  return true;
}

export async function closeMongoConnection() {
  const client = globalForMongo._mongoClient;

  globalForMongo._mongoClient = null;
  globalForMongo._mongoClientPromise = null;

  if (client) {
    await client.close();
  }
}

export function getClientPromise() {
  return getMongoClientPromise();
}
