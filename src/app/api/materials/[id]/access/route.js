import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getPurchaseStatus } from "@/lib/indexer";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  try {
    // Extract the wallet address (mocked via header for tests; normally via cookie/session)
    const walletAddress = request.headers.get('x-user-wallet');
    if (!walletAddress) {
      return NextResponse.json({ error: 'Unauthorized: Wallet connection required' }, { status: 401 });
    }

    const id = params.id;
    const db = await getDb();

    const material = await db.collection("materials").findOne({ _id: id });
    if (!material) {
      return NextResponse.json({ error: 'Material not found' }, { status: 404 });
    }

    // Call our mocked Soroban indexer to verify on-chain entitlement
    const status = await getPurchaseStatus(walletAddress, id);

    if (status === 'available') {
      return NextResponse.json({
        status: 'available',
        accessGranted: true,
        downloadUrl: `https://eduvault.test/downloads/signed/${id}`
      }, { status: 200 });
    }

    return NextResponse.json({ status, accessGranted: false }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}