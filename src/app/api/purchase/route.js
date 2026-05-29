export const dynamic = "force-dynamic";

import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { getUserFromCookie } from "@/lib/api/auth";

export async function GET(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = user.walletAddress;

    const purchases = await db
      .collection("purchases")
      .find({ buyerAddress: userAddress })
      .sort({ createdAt: -1 })
      .toArray();

    return NextResponse.json(purchases);
  } catch (err) {
    console.error("GET /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const body = await req.json();

    const { materialId, signedXdr, email } = body;
    const buyerAddress = user.walletAddress;

    if (!materialId) {
      return NextResponse.json({ error: "Missing materialId" }, { status: 400 });
    }

    // Prevent duplicate purchases
    const existing = await db
      .collection('purchases')
      .findOne({ buyerAddress, materialId });
    if (existing) {
      return NextResponse.json(
        { message: 'Already purchased', purchase: existing, transactionHash: existing.transactionHash },
        { status: 200 }
      );
    }

    const purchaseRecord = {
      materialId,
      buyerAddress,
      userEmail: email || null,
      status: 'confirmed',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('purchases').insertOne(purchaseRecord);

    return NextResponse.json(
      { success: true, purchaseId: result.insertedId, purchase: { ...purchaseRecord, _id: result.insertedId } },
      { status: 201 }
    );
  } catch (err) {
    console.error("POST /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
