export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { pinata } from "@/lib/pinata";
import { verifyEmailConnection } from "@/lib/email";
import { withApiHardening } from "@/lib/api/hardening";
import { Server, rpc } from "@stellar/stellar-sdk";
import { HORIZON_URL, STELLAR_RPC_URL } from "@/lib/config/chain";
import { setGauge } from "@/lib/telemetry/metrics";

/**
 * Bounded timeout wrapper ensuring dependency checks cannot hang indefinitely
 * during network partitions or downstream outages (#169).
 */
function withTimeout(promise, timeoutMs, dependencyName) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${dependencyName} check exceeded bounded timeout of ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Readiness probe (#169 / #20): "can this instance reliably serve end-user traffic?"
 *
 * Failure semantics:
 *  - CRITICAL down (database, stellar RPC) -> core purchases/contracts fail -> "unhealthy" HTTP 503.
 *  - NON-CRITICAL down (pinata, email, indexer) -> browsing/reads still work -> "degraded" HTTP 200.
 */
const CRITICAL_DEPENDENCIES = new Set(["database", "stellar"]);
const CHECK_TIMEOUT_MS = 3000;

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "readiness-check", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const status = {
        database: "offline",
        pinata: "offline",
        email: "offline",
        stellar: "offline",
        indexer: "offline",
      };

      const failedCritical = [];
      const failedNonCritical = [];

      function recordFailure(dep, reason) {
        status[dep] = `offline: ${reason}`;
        if (CRITICAL_DEPENDENCIES.has(dep)) {
          failedCritical.push(dep);
        } else {
          failedNonCritical.push(dep);
        }
      }

      // 1. Database (Critical with bounded timeout)
      try {
        const db = await withTimeout(getDb(), CHECK_TIMEOUT_MS, "database_connect");
        await withTimeout(db.command({ ping: 1 }), CHECK_TIMEOUT_MS, "database_ping");
        status.database = "online";
      } catch (err) {
        recordFailure("database", err.message);
      }

      // 2. Pinata (Non-critical - degrades IPFS media only)
      try {
        if (!process.env.PINATA_JWT) {
          recordFailure("pinata", "PINATA_JWT not configured");
        } else {
          await withTimeout(pinata.testAuthentication(), CHECK_TIMEOUT_MS, "pinata");
          status.pinata = "online";
        }
      } catch (err) {
        recordFailure("pinata", err.message);
      }

      // 3. Email (Non-critical - degrades email alerts only)
      try {
        await withTimeout(verifyEmailConnection(), CHECK_TIMEOUT_MS, "email");
        status.email = "online";
      } catch (err) {
        recordFailure("email", err.message);
      }

      // 4. Stellar Horizon & RPC (Critical with bounded timeout)
      try {
        const horizonServer = new Server(HORIZON_URL);
        await withTimeout(horizonServer.root(), CHECK_TIMEOUT_MS, "stellar_horizon");

        const rpcServer = new rpc.Server(STELLAR_RPC_URL);
        const health = await withTimeout(rpcServer.getHealth(), CHECK_TIMEOUT_MS, "stellar_rpc");

        if (health && health.status === "healthy") {
          status.stellar = "online";
        } else {
          recordFailure("stellar", `RPC status is ${health?.status || "unknown"}`);
        }
      } catch (err) {
        recordFailure("stellar", err.message);
      }

      // 5. Worker / Indexer Freshness Check (Non-critical)
      try {
        if (status.database === "online") {
          const db = await getDb();
          const stateDoc = await withTimeout(
            db.collection("indexer_state").findOne({ _id: "stellar_indexer" }),
            CHECK_TIMEOUT_MS,
            "indexer_state"
          );

          if (!stateDoc || !stateDoc.updatedAt) {
            status.indexer = "idle: no active sync recorded";
          } else {
            const ageMs = Date.now() - new Date(stateDoc.updatedAt).getTime();
            const MAX_ALLOWED_LAG_MS = 15 * 60 * 1000; // 15 mins
            if (ageMs > MAX_ALLOWED_LAG_MS) {
              recordFailure("indexer", `stale: last indexed ${Math.floor(ageMs / 1000)}s ago`);
            } else {
              status.indexer = "online";
            }
          }
        } else {
          recordFailure("indexer", "database dependency offline");
        }
      } catch (err) {
        recordFailure("indexer", err.message);
      }

      let overall;
      let statusCode;
      if (failedCritical.length > 0) {
        overall = "unhealthy";
        statusCode = 503;
      } else if (failedNonCritical.length > 0) {
        overall = "degraded";
        statusCode = 200;
      } else {
        overall = "healthy";
        statusCode = 200;
      }

      for (const [dep, value] of Object.entries(status)) {
        setGauge("dependency_up", { dependency: dep }, value === "online" ? 1 : 0);
      }

      return NextResponse.json(
        {
          status: overall,
          timestamp: new Date().toISOString(),
          services: status,
          failedCritical,
          failedNonCritical,
        },
        { status: statusCode }
      );
    }
  );
}