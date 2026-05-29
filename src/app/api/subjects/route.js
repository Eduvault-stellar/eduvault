export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import { getTaxonomy, getSubjectsByCategory } from "@/lib/backend/taxonomy";

// GET /api/subjects
// Returns canonical taxonomy data (categories, subjects, levels)
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "subjects", rateLimit: { limit: 100, windowMs: 60_000 } },
    async () => {
      try {
        const url = new URL(request.url);
        const categoryId = url.searchParams.get("category");

        if (categoryId) {
          const subjects = getSubjectsByCategory(categoryId);
          return NextResponse.json({ subjects, categoryId });
        }

        return NextResponse.json(getTaxonomy());
      } catch (error) {
        auditLog({ event: "subjects_list_failed", route: "subjects", method: "GET", status: 500, reason: error.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
