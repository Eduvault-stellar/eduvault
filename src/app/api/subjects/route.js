export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";

// GET /api/subjects
// Returns list of available subject categories
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "subjects", rateLimit: { limit: 100, windowMs: 60_000 } },
    async () => {
      try {
        // Static list of subjects - can be made dynamic later from DB if needed
        const subjects = [
          "All",
          "Math",
          "Science",
          "Law",
          "Technology",
          "Business",
          "Medicine",
          "Arts",
          "Social Sciences",
          "Engineering",
          "Pharmacy",
          "Humanities",
          "Education"
        ];

        return NextResponse.json({ subjects });
      } catch (error) {
        auditLog({ event: "subjects_list_failed", route: "subjects", method: "GET", status: 500, reason: error.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
