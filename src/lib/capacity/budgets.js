/**
 * Capacity budgets — per-route SLO-derived limits for request time,
 * memory, database connections, queue depth, and payload size.
 *
 * Budgets are the contract between production SLOs and admission control.
 * When a route's budget is exhausted, requests receive stable 503 overload
 * responses with retry guidance instead of cascading failures.
 */

// ── Global System Limits ─────────────────────────────────────────────────────

export const SYSTEM_LIMITS = Object.freeze({
  /** Maximum total concurrent in-flight requests across all routes. */
  maxConcurrentRequests: 200,

  /** Maximum concurrent MongoDB operations system-wide. */
  maxMongoOperations: 50,

  /** Maximum concurrent outbound HTTP calls (RPC, IPFS, Horizon). */
  maxOutboundHttp: 30,

  /** Maximum total queue depth for deferred/background work. */
  maxQueueDepth: 500,

  /** Memory soft-limit per process (bytes). */
  memorySoftLimitBytes: 512 * 1024 * 1024,

  /** Memory hard-limit — start shedding before this. */
  memoryHardLimitBytes: 768 * 1024 * 1024,
});

// ── Route Budgets ────────────────────────────────────────────────────────────

/**
 * Budget definitions per route.
 *
 * Fields:
 *   maxConcurrent    — max simultaneous in-flight requests
 *   maxQueueDepth    — max waiting requests in the admission queue
 *   timeoutMs        — per-request hard timeout
 *   maxPayloadBytes  — maximum request body size
 *   priority         — shedding order: lower = shed first
 *   degradeWith      — optional: list of subsystems that degrade gracefully
 *   retries          — max client retry suggestions in 503 Retry-After
 *   retryAfterBaseMs — base for exponential retry-after header
 */
export const ROUTE_BUDGETS = Object.freeze({
  // ── Critical: purchase, entitlement, protected delivery ─────────────
  "POST:/api/purchase": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 15_000,
    maxPayloadBytes: 64 * 1024,
    priority: 0,
    degradeWith: [],
    retries: 3,
    retryAfterBaseMs: 2_000,
  },
  "GET:/api/download": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 30_000,
    maxPayloadBytes: 0,
    priority: 0,
    degradeWith: [],
    retries: 3,
    retryAfterBaseMs: 1_000,
  },
  "GET:/api/entitlements": {
    maxConcurrent: 25,
    maxQueueDepth: 50,
    timeoutMs: 8_000,
    maxPayloadBytes: 0,
    priority: 0,
    degradeWith: [],
    retries: 3,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/checkout/verify": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 10_000,
    maxPayloadBytes: 8_192,
    priority: 0,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },

  // ── High: uploads, materials ───────────────────────────────────────
  "POST:/api/upload": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 60_000,
    maxPayloadBytes: 15 * 1024 * 1024,
    priority: 1,
    degradeWith: ["ipfs"],
    retries: 2,
    retryAfterBaseMs: 5_000,
  },
  "POST:/api/materials": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 10_000,
    maxPayloadBytes: 64 * 1024,
    priority: 1,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },
  "PUT:/api/materials": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 10_000,
    maxPayloadBytes: 64 * 1024,
    priority: 1,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },
  "PATCH:/api/materials": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 10_000,
    maxPayloadBytes: 64 * 1024,
    priority: 1,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },

  // ── Medium: search, reviews, marketplace ───────────────────────────
  "GET:/api/market-materials": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 8_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/reviews/publish": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 8_000,
    maxPayloadBytes: 32 * 1024,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },
  "GET:/api/materials": {
    maxConcurrent: 25,
    maxQueueDepth: 50,
    timeoutMs: 8_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },

  // ── Low: metrics, health, admin, provenance backfill ───────────────
  "GET:/api/health": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 3_000,
    maxPayloadBytes: 0,
    priority: 3,
    degradeWith: [],
    retries: 0,
    retryAfterBaseMs: 1_000,
  },
  "GET:/api/metrics": {
    maxConcurrent: 5,
    maxQueueDepth: 10,
    timeoutMs: 2_000,
    maxPayloadBytes: 0,
    priority: 3,
    degradeWith: [],
    retries: 0,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/provenance/backfill": {
    maxConcurrent: 5,
    maxQueueDepth: 10,
    timeoutMs: 30_000,
    maxPayloadBytes: 16_384,
    priority: 3,
    degradeWith: ["mongo"],
    retries: 1,
    retryAfterBaseMs: 10_000,
  },
  "POST:/api/provenance/version": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 10_000,
    maxPayloadBytes: 32_768,
    priority: 2,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },

  // ── Critical: funds-moving flows (checkout, refunds) ─────────────────
  "GET:/api/purchase": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 8_000,
    maxPayloadBytes: 0,
    priority: 0,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/checkout/initiate": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 10_000,
    maxPayloadBytes: 8_192,
    priority: 0,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },
  "GET:/api/checkout/initiate": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/checkout/refund": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 10_000,
    maxPayloadBytes: 4_096,
    priority: 0,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 5_000,
  },
  "POST:/api/checkout/verify-promo": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 5_000,
    maxPayloadBytes: 4_096,
    priority: 1,
    degradeWith: ["mongo"],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },

  // ── Critical: admin financial state transitions ─────────────────────
  "POST:/api/admin/refunds/approve": {
    maxConcurrent: 5,
    maxQueueDepth: 10,
    timeoutMs: 20_000,
    maxPayloadBytes: 4_096,
    priority: 0,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 5_000,
  },

  // ── High: admin moderation state transitions ─────────────────────────
  "POST:/api/admin/users/suspend": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 10_000,
    maxPayloadBytes: 8_192,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },
  "GET:/api/admin/disputes": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 8_000,
    maxPayloadBytes: 0,
    priority: 1,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 2_000,
  },
  "PATCH:/api/admin/disputes": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 10_000,
    maxPayloadBytes: 8_192,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },
  "POST:/api/admin/verification": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 10_000,
    maxPayloadBytes: 8_192,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },

  // ── High: application creation (student verification, incl. document upload) ──
  "POST:/api/verification/student": {
    maxConcurrent: 5,
    maxQueueDepth: 10,
    timeoutMs: 30_000,
    maxPayloadBytes: 6 * 1024 * 1024,
    priority: 1,
    degradeWith: ["mongo"],
    retries: 1,
    retryAfterBaseMs: 10_000,
  },
  "GET:/api/verification/student": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },

  // ── High: material publish state transition (dynamic route — keyed by
  //     the route label passed to withApiHardening, see resolveRouteBudget) ──
  "POST:material-publish": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 10_000,
    maxPayloadBytes: 8_192,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },
  "GET:material-publish": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: [],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },

  // ── Medium: access status / access requests ──────────────────────────
  "GET:/api/materials/access": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/materials/access": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 8_000,
    maxPayloadBytes: 8_192,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },
  "GET:material-access-status": {
    maxConcurrent: 30,
    maxQueueDepth: 60,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },

  // ── Medium: abuse reporting, history, analytics ──────────────────────
  "POST:/api/reviews/report": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 8_000,
    maxPayloadBytes: 16_384,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },
  "GET:/api/reviews/report": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },
  "GET:/api/transactions/history": {
    maxConcurrent: 25,
    maxQueueDepth: 50,
    timeoutMs: 10_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 2,
    retryAfterBaseMs: 1_000,
  },
  "GET:/api/creator/analytics": {
    maxConcurrent: 15,
    maxQueueDepth: 30,
    timeoutMs: 15_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 1,
    retryAfterBaseMs: 3_000,
  },

  // ── Low: expensive export, notifications, internal service hooks ────
  "GET:/api/creator/analytics/export": {
    maxConcurrent: 5,
    maxQueueDepth: 10,
    timeoutMs: 30_000,
    maxPayloadBytes: 0,
    priority: 3,
    degradeWith: ["mongo"],
    retries: 0,
    retryAfterBaseMs: 10_000,
  },
  "POST:/api/auth/logout": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 5_000,
    maxPayloadBytes: 2_048,
    priority: 1,
    degradeWith: [],
    retries: 1,
    retryAfterBaseMs: 2_000,
  },
  "POST:/api/csp-report": {
    maxConcurrent: 20,
    maxQueueDepth: 40,
    timeoutMs: 3_000,
    maxPayloadBytes: 16_384,
    priority: 3,
    degradeWith: [],
    retries: 0,
    retryAfterBaseMs: 1_000,
  },
  "POST:/api/indexer": {
    maxConcurrent: 3,
    maxQueueDepth: 5,
    timeoutMs: 55_000,
    maxPayloadBytes: 0,
    priority: 1,
    degradeWith: ["mongo"],
    retries: 0,
    retryAfterBaseMs: 5_000,
  },
  "GET:/api/indexer": {
    maxConcurrent: 10,
    maxQueueDepth: 20,
    timeoutMs: 5_000,
    maxPayloadBytes: 0,
    priority: 2,
    degradeWith: ["mongo"],
    retries: 1,
    retryAfterBaseMs: 2_000,
  },
});

// ── Lookup Helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the budget for a route+method combination.
 * Falls back to a sensible default for unknown routes.
 *
 * @param {string} method - HTTP method
 * @param {string} route  - Route path (e.g. "/api/purchase")
 * @returns {object} Budget definition
 */
export function getRouteBudget(method, route) {
  const key = `${method}:${route}`;
  return ROUTE_BUDGETS[key] || DEFAULT_BUDGET;
}

/**
 * Resolve a route's budget the way `withApiHardening` actually calls sites:
 * route handlers pass a short human-readable label (e.g. "material-publish")
 * that rarely matches the "/api/..." path keys above. Try the real request
 * pathname first (what most ROUTE_BUDGETS keys are written against), then
 * fall back to the caller-supplied label (for dynamic routes where the
 * pathname includes a resource id and can't be a static key), then default.
 *
 * @param {string} method
 * @param {{ pathname?: string, label?: string }} lookup
 */
export function resolveRouteBudget(method, { pathname, label } = {}) {
  if (pathname) {
    const byPath = ROUTE_BUDGETS[`${method}:${pathname}`];
    if (byPath) return byPath;
  }
  if (label) {
    const byLabel = ROUTE_BUDGETS[`${method}:${label}`];
    if (byLabel) return byLabel;
  }
  return DEFAULT_BUDGET;
}

const DEFAULT_BUDGET = Object.freeze({
  maxConcurrent: 20,
  maxQueueDepth: 40,
  timeoutMs: 10_000,
  maxPayloadBytes: 1024 * 1024,
  priority: 2,
  degradeWith: [],
  retries: 2,
  retryAfterBaseMs: 2_000,
});

// ── Overload Response Builder ────────────────────────────────────────────────

/**
 * Build a standardized 503 overload response.
 *
 * @param {object} params
 * @param {string} params.route
 * @param {string} params.reason - "queue_full" | "concurrency_limit" | "timeout" | "system_overload"
 * @param {number} params.retryAfterSeconds
 * @param {string} [params.detail]
 * @returns {{ status: number, body: object, headers: object }}
 */
export function buildOverloadResponse({ route, reason, retryAfterSeconds, detail }) {
  return {
    status: 503,
    body: {
      error: "Service temporarily overloaded",
      reason,
      route,
      retryAfter: retryAfterSeconds,
      detail: detail || "The service is handling high load. Please retry after the specified interval.",
    },
    headers: {
      "Retry-After": String(retryAfterSeconds),
      "Cache-Control": "no-store",
      "X-Overload-Reason": reason,
    },
  };
}
