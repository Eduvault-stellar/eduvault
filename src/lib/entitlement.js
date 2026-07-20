import { getDb } from '@/lib/mongodb';
import { PURCHASE_MANAGER_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE } from '@/lib/config/chain';
import { isCompletedPurchaseStatus, normalizeBuyerAddress } from '@/lib/purchases/access';
import { Contract, Address, nativeToScVal, scValToNative, xdr, TransactionBuilder, Account } from '@stellar/stellar-sdk';
import logger from '@/lib/logger';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes positive TTL
const NEGATIVE_TTL_MS = 60 * 1000; // 1 minute negative TTL
const PENDING_REQS = new Map();

export async function getCachedEntitlement(db, materialId, buyerAddress) {
  return db.collection('entitlement_cache').findOne({
    materialId,
    buyerAddress: buyerAddress.toLowerCase(),
    contractId: PURCHASE_MANAGER_CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
  });
}

export async function setCachedEntitlement(db, materialId, buyerAddress, active, source = 'chain') {
  const now = new Date();
  const ttl = active ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);

  await db.collection('entitlement_cache').updateOne(
    { materialId, buyerAddress: buyerAddress.toLowerCase() },
    {
      $set: {
        materialId,
        buyerAddress: buyerAddress.toLowerCase(),
        active,
        source: active ? source : `${source}-miss`,
        contractId: PURCHASE_MANAGER_CONTRACT_ID,
        network: NETWORK_PASSPHRASE,
        verifiedAt: now,
        expiresAt,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

// Ensure materialId is exactly 32 bytes for BytesN<32>
export function formatMaterialIdBytes(materialId) {
  if (typeof materialId === 'string' && materialId.length === 64 && /^[0-9a-f]+$/i.test(materialId)) {
    return Buffer.from(materialId, 'hex');
  }
  let buf = Buffer.alloc(32);
  buf.write(materialId || '', 'utf8');
  return buf;
}

export function buildHasEntitlementXdr(materialId, buyerAddress) {
  const contract = new Contract(PURCHASE_MANAGER_CONTRACT_ID);
  const matIdScVal = nativeToScVal(formatMaterialIdBytes(materialId), { type: 'bytesN', size: 32 });
  const buyerScVal = new Address(buyerAddress).toScVal();

  const op = contract.call('has_entitlement', matIdScVal, buyerScVal);

  const tx = new TransactionBuilder(new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "1"), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

export function decodeBoolean(xdrBase64) {
  try {
    const scval = xdr.ScVal.fromXDR(xdrBase64, 'base64');
    return scValToNative(scval) === true;
  } catch (err) {
    logger?.warn({ err: err.message }, 'Failed to decode boolean from SCVal');
    return false;
  }
}

export async function checkChainEntitlement(materialId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !STELLAR_RPC_URL) return null;

  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: buildHasEntitlementXdr(materialId, buyerAddress),
      },
    };

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const payload = await res.json();
    if (payload.error) {
      logger?.error({ err: payload.error }, 'RPC Error in checkChainEntitlement');
      return null;
    }

    if (payload.result?.restorePreamble) {
      logger?.warn({ materialId, buyerAddress }, 'Archived state detected in checkChainEntitlement (restorePreamble)');
      return null;
    }

    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) {
      logger?.warn({ result: payload.result }, 'Malformed result in checkChainEntitlement');
      return null;
    }

    const hasAccess = decodeBoolean(retval);
    logger?.info({ materialId, buyerAddress, hasAccess }, 'Chain read entitlement');
    return hasAccess;
  } catch (err) {
    logger?.error({ err: err.message }, 'Timeout or network error in checkChainEntitlement');
    return null;
  }
}

/**
 * Create an entitlement record for a buyer after a successful purchase.
 * Writes to the entitlement_cache collection for fast subsequent lookups.
 *
 * @param {object} db - MongoDB database instance (optional; will be fetched if omitted)
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's Stellar public key
 * @param {object} [purchaseData] - Optional purchase metadata to store
 * @param {string} [purchaseData.purchaseId] - The purchase record ID
 * @param {string} [purchaseData.transactionHash] - On-chain transaction hash
 * @param {string} [purchaseData.amount] - Purchase amount
 * @param {string} [purchaseData.asset] - Payment asset code
 * @returns {Promise<{success: boolean, source: string}>}
 */
export async function createEntitlement(materialId, buyerAddress, purchaseData = {}) {
  if (!materialId || !buyerAddress) {
    return { success: false, source: 'invalid-params' };
  }

  const db = await getDb();
  const normalised = buyerAddress.toLowerCase();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

  const entry = {
    materialId,
    buyerAddress: normalised,
    active: true,
    source: 'purchase-api',
    purchaseId: purchaseData.purchaseId || null,
    transactionHash: purchaseData.transactionHash || null,
    amount: purchaseData.amount || null,
    asset: purchaseData.asset || null,
    contractId: PURCHASE_MANAGER_CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    verifiedAt: now,
    expiresAt,
    updatedAt: now,
    createdAt: now,
  };

  const session = purchaseData.session || null;

  await db.collection('entitlement_cache').updateOne(
    { materialId, buyerAddress: normalised },
    { $set: entry },
    { upsert: true, session }
  );

  return { success: true, source: 'purchase-api' };
}

/**
 * Revoke (deactivate) an entitlement.
 *
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's wallet address
 * @returns {Promise<{success: boolean}>}
 */
export async function revokeEntitlement(materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { success: false };
  }

  const db = await getDb();
  const normalised = buyerAddress.toLowerCase();
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NEGATIVE_TTL_MS);

  await db.collection('entitlement_cache').updateOne(
    { materialId, buyerAddress: normalised },
    {
      $set: {
        active: false,
        source: 'revoked',
        contractId: PURCHASE_MANAGER_CONTRACT_ID,
        network: NETWORK_PASSPHRASE,
        verifiedAt: now,
        expiresAt,
        updatedAt: now,
      },
      $setOnInsert: {
        materialId,
        buyerAddress: normalised,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  return { success: true };
}

// Internal verified logic extracted to allow dependency injection during tests
export async function verifyEntitlementLogic(materialId, buyerAddress, { db, checkChain, getCache, setCache }) {
  const normalised = normalizeBuyerAddress(buyerAddress);
  const now = new Date();

  const cached = await getCache(db, materialId, normalised);
  if (cached) {
    // Check if cache is still valid
    if (cached.expiresAt && cached.expiresAt > now) {
      if (cached.active) return { hasAccess: true, source: cached.source || 'cache' };
      // Fall through to DB check for inactive if it could be out of date?
      // With a negative TTL, it expires quickly. If it's valid, it's inactive.
      return { hasAccess: false, source: cached.source || 'cache-miss' };
    }
  }

  // Purchases DB
  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: normalised,
  });

  if (purchase && isCompletedPurchaseStatus(purchase.status)) {
    await setCache(db, materialId, normalised, true, 'purchases-db');
    return { hasAccess: true, source: 'purchases-db' };
  }

  // Fallback to chain
  const onChain = await checkChain(materialId, buyerAddress);
  if (onChain === true) {
    await setCache(db, materialId, normalised, true, 'chain');
    return { hasAccess: true, source: 'chain' };
  }
  
  if (onChain === false) {
    await setCache(db, materialId, normalised, false, 'chain');
    return { hasAccess: false, source: 'chain-miss' };
  }

  // Fail-open/stale fallback: if chain fails (returns null) and we have a stale cache entry, return it
  if (onChain === null && cached) {
    logger?.warn({ materialId, buyerAddress }, 'Chain verify failed, falling back to stale cache');
    return { hasAccess: cached.active, source: 'stale-cache' };
  }

  return { hasAccess: false, source: 'not-found' };
}

export async function verifyEntitlement(materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { hasAccess: false, source: 'invalid-params' };
  }

  const normalised = normalizeBuyerAddress(buyerAddress);
  const key = `${materialId}:${normalised}`;

  if (PENDING_REQS.has(key)) {
    return PENDING_REQS.get(key);
  }

  const promise = (async () => {
    const db = await getDb();
    return verifyEntitlementLogic(materialId, buyerAddress, {
      db,
      checkChain: checkChainEntitlement,
      getCache: getCachedEntitlement,
      setCache: setCachedEntitlement,
    });
  })();

  PENDING_REQS.set(key, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    PENDING_REQS.delete(key);
  }
}

export function requireEntitlement(handler, getMaterialId) {
  return async function protectedHandler(request, context) {
    const { searchParams } = new URL(request.url);
    const buyerAddress = searchParams.get('buyerAddress') ?? '';
    const materialId =
      typeof getMaterialId === 'function'
        ? getMaterialId(request, context)
        : searchParams.get('materialId') ?? '';

    if (!buyerAddress || !materialId) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json(
        { error: 'Missing buyerAddress or materialId' },
        { status: 400 }
      );
    }

    const { hasAccess, source } = await verifyEntitlement(
      materialId,
      buyerAddress
    );

    if (!hasAccess) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json(
        {
          error: 'Unlicensed Access',
          detail:
            'You do not hold an active entitlement for this material. Please purchase it first.',
        },
        { status: 403 }
      );
    }

    return handler(request, context, { materialId, buyerAddress, source });
  };
}
