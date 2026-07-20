export const dynamic = "force-dynamic";

import { getDb, getClientPromise } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { getUserFromCookie } from "@/lib/api/auth";
import { createEntitlement } from '@/lib/entitlement';
import {
  getMaterialAccessStatus,
  isCompletedPurchaseStatus,
  normalizeBuyerAddress,
} from "@/lib/purchases/access";
import { broadcastPurchaseEvent } from '@/lib/webhooks/sender';
import { getLatestManifest } from "@/lib/provenance/registry";
import { insertOutboxEvent, OUTBOX_EVENT_TYPES } from '@/lib/outbox';
import { PURCHASE_STATES } from '@/lib/purchases/stateMachine';
import { verifyPurchaseTransaction, PurchaseVerificationError } from '@/lib/purchases/chainVerifier';

export async function GET(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);

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
  let session = null;
  try {
    const user = await getUserFromCookie(req);
    const db = await getDb();
    const client = await getClientPromise();
    const body = await req.json();

    const { materialId, signedXdr, email, transactionHash, amount, asset, buyerAddress: bodyBuyerAddress } = body;
    const buyerAddress = normalizeBuyerAddress(
      user?.walletAddress || user?.address || user?.id || bodyBuyerAddress
    );
    const paymentCompleted = Boolean(transactionHash);

    if (!materialId) {
      return NextResponse.json({ error: "Missing materialId" }, { status: 400 });
    }

    if (!buyerAddress) {
      return NextResponse.json({ error: user ? "Missing buyer address" : "Unauthorized" }, { status: user ? 400 : 401 });
    }

    if (signedXdr && !transactionHash) {
      return NextResponse.json({ error: "A signed envelope is not proof of settlement" }, { status: 422 });
    }

    let chainReceipt = null;
    if (transactionHash) {
      try {
        chainReceipt = await verifyPurchaseTransaction({ transactionHash, buyerAddress, materialId, asset, amount });
      } catch (error) {
        if (error instanceof PurchaseVerificationError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
        }
        throw error;
      }
    }

    session = client.startSession();

    let purchaseResponse;

    await session.withTransaction(async () => {
      // Prevent duplicate purchases
      const existing = await db
        .collection('purchases')
        .findOne({ buyerAddress, materialId }, { session });

      if (existing) {
        if (isCompletedPurchaseStatus(existing.status) || existing.status === PURCHASE_STATES.CONFIRMED) {
          await createEntitlement(materialId, buyerAddress, {
            purchaseId: String(existing._id),
            transactionHash: existing.transactionHash,
            session,
          });
          const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
          purchaseResponse = {
            status: 200,
            body: { message: 'Already purchased', purchase: existing, access, transactionHash: existing.transactionHash }
          };
          return;
        }

        if (!paymentCompleted) {
          const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
          purchaseResponse = {
            status: 202,
            body: { message: 'Payment pending', purchase: existing, access }
          };
          return;
        }

        const now = new Date();
        await db.collection('purchases').updateOne(
          { _id: existing._id },
          {
            $set: {
              status: PURCHASE_STATES.CONFIRMED,
              transactionHash: transactionHash || existing.transactionHash || null,
              signedXdr: signedXdr || existing.signedXdr || null,
              amount: amount ?? existing.amount ?? null,
              asset: asset || existing.asset || null,
              userEmail: email || existing.userEmail || null,
              purchasedAt: existing.purchasedAt || now,
              confirmedAt: now,
              updatedAt: now,
            },
          },
          { session }
        );

        const purchase = await db.collection('purchases').findOne({ _id: existing._id }, { session });
        
        await createEntitlement(materialId, buyerAddress, {
          purchaseId: String(existing._id),
          transactionHash: transactionHash || existing.transactionHash || null,
          session,
        });

        const access = await getMaterialAccessStatus(db, materialId, buyerAddress);

      const now = new Date();

      let versionBinding = null;
      try {
        const latestManifest = await getLatestManifest(materialId);
        if (latestManifest) {
          versionBinding = {
            version: latestManifest.version,
            manifestDigest: latestManifest.digest,
            fileCid: latestManifest.manifest?.file?.cid || null,
            fileHash: latestManifest.manifest?.file?.hash || null,
            boundAt: now.toISOString(),
          };
        }
      } catch (bindingErr) {
        console.warn("[purchase] Failed to resolve version binding:", bindingErr?.message);
      }

      await db.collection('purchases').updateOne(
        { _id: existing._id },
        {
          $set: {
            status: 'confirmed',
            transactionHash: transactionHash || existing.transactionHash || null,
            signedXdr: signedXdr || existing.signedXdr || null,
            amount: amount ?? existing.amount ?? null,
            asset: asset || existing.asset || null,
            userEmail: email || existing.userEmail || null,
            purchasedVersion: versionBinding?.version || existing.purchasedVersion || null,
            versionBinding: versionBinding || existing.versionBinding || null,
            purchasedAt: existing.purchasedAt || now,
            confirmedAt: now,
            updatedAt: now,
          },
        if (paymentCompleted) {
          await insertOutboxEvent(db, session, {
            type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
            payload: {
              materialId,
              buyerAddress,
              amount: amount ?? existing.amount,
              asset: asset || existing.asset,
              transactionHash: transactionHash || existing.transactionHash,
            },
            idempotencyKey: `webhook_${existing._id}_${transactionHash || 'nohash'}`,
          });
        }

        purchaseResponse = {
          status: 200,
          body: { success: true, purchaseId: existing._id, purchase, access, transactionHash: purchase?.transactionHash }
        };
        return;
      }

      const now = new Date();

      const purchaseRecord = {
        materialId,
        buyerAddress,
        userEmail: email || null,
        status: paymentCompleted ? PURCHASE_STATES.CONFIRMED : PURCHASE_STATES.PENDING,
        transactionHash: transactionHash || null,
        chainReceipt,
        signedXdr: signedXdr || null,
        amount: amount ?? null,
        asset: asset || null,
        purchasedAt: paymentCompleted ? now : null,
        confirmedAt: paymentCompleted ? now : null,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db.collection('purchases').insertOne(purchaseRecord, { session });
      purchaseRecord._id = result.insertedId;
      
      let access;
      if (paymentCompleted) {
        await createEntitlement(materialId, buyerAddress, {
          purchaseId: String(result.insertedId),
          transactionHash: transactionHash || null,
          session,
        });

        await insertOutboxEvent(db, session, {
          type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
          payload: {
            materialId,
            buyerAddress,
            amount: amount ?? null,
            asset: asset || null,
            transactionHash: transactionHash || null,
          },
          idempotencyKey: `webhook_${result.insertedId}_${transactionHash || 'nohash'}`,
        });
      }

    const now = new Date();

    let versionBinding = null;
    try {
      const latestManifest = await getLatestManifest(materialId);
      if (latestManifest) {
        versionBinding = {
          version: latestManifest.version,
          manifestDigest: latestManifest.digest,
          fileCid: latestManifest.manifest?.file?.cid || null,
          fileHash: latestManifest.manifest?.file?.hash || null,
          boundAt: now.toISOString(),
        };
      }
    } catch (bindingErr) {
      console.warn("[purchase] Failed to resolve version binding:", bindingErr?.message);
    }

    const purchaseRecord = {
      materialId,
      buyerAddress,
      userEmail: email || null,
      status: paymentCompleted ? 'confirmed' : 'pending',
      transactionHash: transactionHash || null,
      chainReceipt,
      signedXdr: signedXdr || null,
      amount: amount ?? null,
      asset: asset || null,
      purchasedVersion: versionBinding?.version || null,
      versionBinding,
      purchasedAt: paymentCompleted ? now : null,
      confirmedAt: paymentCompleted ? now : null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('purchases').insertOne(purchaseRecord);
    const access = await getMaterialAccessStatus(db, materialId, buyerAddress);

    if (paymentCompleted) {
      await createEntitlement(materialId, buyerAddress, {
        purchaseId: String(result.insertedId),
        transactionHash: transactionHash || null,
      });
      access = await getMaterialAccessStatus(db, materialId, buyerAddress);

      purchaseResponse = {
        status: paymentCompleted ? 201 : 202,
        body: { success: paymentCompleted, purchaseId: result.insertedId, purchase: purchaseRecord, access }
      };
    });

    return NextResponse.json(purchaseResponse.body, { status: purchaseResponse.status });
  } catch (err) {
    console.error("POST /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}
