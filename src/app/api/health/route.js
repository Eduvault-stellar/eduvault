export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from '@/lib/api/hardening';

/**
 * Liveness probe (#169 / #20): "is the process itself running and able to respond?"
 *
 * Invariant:
 * Strictly zero external network or database dependencies. Liveness must remain
 * ultra-cheap (<5ms) so orchestrators (Kubernetes / ECS) can determine whether
 * the runtime loop is responsive without triggering cascading restart loops
 * when external downstreams degrade.
 */
export const GET = withApiHardening(
  async () => {
    return NextResponse.json(
      {
        status: "alive",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  },
  {
    route: 'health',
    rateLimit: { limit: 120, windowMs: 60_000 },
  }
);