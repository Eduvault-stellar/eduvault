export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";

export async function POST(request, { params }) {
    try {
        const materialId = params?.id;
        if (!materialId) {
            return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const db = await getDb();
        const existing = await db.collection("materials").findOne({ _id: materialId });
        if (!existing) {
            return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const body = await request.json().catch(() => ({}));
        const contractId = typeof body.contractId === "string" ? body.contractId.trim() : undefined;

        const updatePayload = {
            status: "published",
            updatedAt: new Date(),
        };

        if (contractId) {
            updatePayload.contractId = contractId;
        }

        await db.collection("materials").updateOne(
            { _id: materialId },
            { $set: updatePayload }
        );

        return NextResponse.json({ success: true, status: "published" }, { status: 200 });
    } catch (err) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
}
