export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { validateImportPayload, ImportValidationError } from "@/lib/backend/materialImport";

export const runtime = "nodejs";

// POST /api/materials/import
// Bulk import materials from JSON payload
// Supports dry-run via body.dryRun (default: true)
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "materials-import", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "materials-import", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        let userAddress = user.walletAddress || user.address || null;
        if (!userAddress && user.sub) {
          try {
            const { ObjectId } = await import("mongodb");
            const dbUser = await (await getDb()).collection("users").findOne({ _id: new ObjectId(user.sub) });
            userAddress = dbUser?.walletAddress || dbUser?.walletAddressLower || null;
          } catch (e) {
            console.warn("User lookup failed during import:", e?.message || e);
          }
        }

        if (!userAddress) {
          return NextResponse.json({ error: "No wallet address associated with account" }, { status: 400 });
        }

        const body = await request.json();
        const validation = validateImportPayload(body);

        // Return validation results for dry-run or when there are invalid rows
        if (validation.dryRun || validation.invalid > 0) {
          return NextResponse.json({
            dryRun: validation.dryRun,
            total: validation.total,
            valid: validation.valid,
            invalid: validation.invalid,
            invalidRows: validation.invalidRows,
            message: validation.dryRun
              ? "Dry-run mode: no records were saved"
              : `${validation.invalid} row(s) have errors. No records were saved.`,
          }, { status: validation.invalid > 0 ? 400 : 200 });
        }

        // Save valid records
        const db = await getDb();
        const now = new Date();

        const docs = validation.validRecords.map((record) => ({
          ...record,
          userAddress,
          createdAt: now,
          updatedAt: now,
        }));

        const result = await db.collection("materials").insertMany(docs);

        auditLog({
          event: "materials_imported",
          route: "materials-import",
          method: "POST",
          status: 201,
          actor: user.sub,
          imported: result.insertedCount,
        });

        return NextResponse.json({
          dryRun: false,
          total: validation.total,
          valid: validation.valid,
          invalid: validation.invalid,
          imported: result.insertedCount,
          invalidRows: validation.invalidRows,
        }, { status: 201 });
      } catch (err) {
        if (err instanceof ImportValidationError) {
          return NextResponse.json({ error: err.message, details: err.details }, { status: 400 });
        }
        if (err.name === "ValidationError") throw err;
        auditLog({ event: "materials_import_failed", route: "materials-import", method: "POST", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
