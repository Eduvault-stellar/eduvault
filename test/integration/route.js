// Material Publish Route Handler
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";

export async function POST(request, { params }) {
    try {
        const id = params.id;
        const db = await getDb();

        const existing = await db.collection("materials").findOne({ _id: id });

        if (!existing) {
            return NextResponse.json({ error: 'Material not found' }, { status: 404 });
        }

        const body = await request.json();

        await db.collection("materials").updateOne(
            { _id: id },
            { $set: { status: 'published', contractId: body.contractId, updatedAt: new Date() } }
        );

        return NextResponse.json({ success: true, status: 'published' }, { status: 200 });
    } catch (error) {
        return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }
}