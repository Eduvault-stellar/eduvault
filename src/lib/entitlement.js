import { getDb } from '@/lib/mongodb';
import { PURCHASE_MANAGER_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE } from '@/lib/config/chain';
import { isCompletedPurchaseStatus, normalizeBuyerAddress } from '@/lib/purchases/access';
import {
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  TransactionBuilder,
  Account,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import logger from '@/lib/logger';

// Positive results (an on-chain / DB confirmed entitlement) are safe to cache
// for longer, since access should be revoked far less often than it is
// granted, and continuing to grant access to an already-entitled buyer for a
// short extra window carries little risk.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes positive TTL

// Negative results (confirmed absence of an entitlement) must expire quickly:
// a buyer who just purchased access needs to be recognized promptly, and we
// never want to keep denying access longer than necessary.
const NEGATIVE_TTL_MS = 60 * 1000; // 1 minute negative TTL

// When the chain read itself fails (RPC timeout, network error, malformed
// response, archived/restore-preamble state, ...) we must NOT treat that as
// a confirmed negative - doing so would cache a transient outage as "no
// entitlement" and lock out a paying buyer. Instead, on transport failure we
// may fall back to the last verified cache entry, but only within a bounded
// grace window past its own expiry. Beyond that window we fail closed rather
// than trusting arbitrarily stale data forever.
const STALE_GRACE_MS = 15 * 60 * 1000; // 15 minutes beyond expiry

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
  const normalised = buyerAddress.toLowerCase();

  await db.collection('entitlement_cache').updateOne(
    // Scope the upsert filter by contractId/network as well as
    // materialId/buyerAddress so a switch of network or contract can never
    // silently clobber (or be masked by) a cache document verified against a
    // different chain deployment.
    {
      materialId,
      buyerAddress: normalised,
      contractId: PURCHASE_MANAGER_CONTRACT_ID,
      network: NETWORK_PASSPHRASE,
    },
    {
      $set: {
        materialId,
        buyerAddress: normalised,
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
  const buf = Buffer.alloc(32);
  const cleanId = String(materialId || '').replace(/^0x/, '');
  const raw = /^[0-9a-fA-F]+$/.test(cleanId) && cleanId.length > 0
    ? Buffer.from(cleanId, 'hex')
    : Buffer.from(cleanId, 'utf-8');
  raw.copy(buf, Math.max(0, 32 - raw.length));
  return buf;
}

export function buildHasEntitlementXdr(materialId, buyerAddress) {
  const contractId = PURCHASE_MANAGER_CONTRACT_ID || process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID;
  if (!materialId || !buyerAddress || !contractId) return '';

  try {
    const contract = new Contract(contractId);
    const materialIdScVal = xdr.ScVal.scvBytes(formatMaterialIdBytes(materialId));

    let addressScVal;
    try {
      addressScVal = Address.fromString(buyerAddress).toScVal();
    } catch {
      addressScVal = nativeToScVal(buyerAddress, { type: 'address' });
    }

    const dummyAccount = new Account(
      buyerAddress.startsWith('G')
        ? buyerAddress
        : 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      '0'
    );

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE || '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('has_entitlement', materialIdScVal, addressScVal))
      .setTimeout(30)
      .build();

    return tx.toXDR();
  } catch (err) {
    logger?.error({ err: err.message }, 'Failed to build has_entitlement XDR');
    return '';
  }
}

export function decodeBoolean(xdrBase64) {
  if (!xdrBase64) return false;
  try {
    const scval = xdr.ScVal.fromXDR(xdrBase64, 'base64');
    return scValToNative(scval) === true;
  } catch (err) {
    logger?.warn({ err: err.message }, 'Failed to decode boolean from SCVal');
    return false;
  }
}

// Reads entitlement state directly from the Soroban contract.
//
// Return contract (tri-state - callers MUST preserve this distinction and
// never collapse it to a plain boolean before deciding whether to cache):
//   true  -> chain authoritatively confirms the buyer holds the entitlement
//   false -> chain authoritatively confirms the buyer does NOT hold it
//   null  -> the check could not be completed (missing config, RPC/network
//            failure, timeout, malformed response, or archived/unrestored
//            state). This is NOT a negative result and must never be cached
//            as one.
export async function checkChainEntitlement(materialId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID || !STELLAR_RPC_URL) return null;

  try {
    const xdrBlob = buildHasEntitlementXdr(materialId, buyerAddress);
    if (!xdrBlob) return null;

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: { transaction: xdrBlob },
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

  // Grant is authoritative: it must immediately supersede any previously
  // cached negative result for this (materialId, buyerAddress) pair so a
  // just-completed purchase is recognized on the very next check.
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
    // A cache entry within its own TTL is authoritative for its polarity:
    // a fresh positive grants access, a fresh negative (short TTL) denies
    // it. Expired entries fall through to re-verification below.
    if (cached.expiresAt && cached.expiresAt > now) {
      if (cached.active) return { hasAccess: true, source: cached.source || 'cache' };
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
    // Authoritative negative: safe to cache, but only briefly.
    await setCache(db, materialId, normalised, false, 'chain-miss');
    return { hasAccess: false, source: 'chain-miss' };
  }

  // onChain === null: the chain read itself failed (transport error, RPC
  // outage, malformed response, ...). This is NOT an authoritative negative
  // and must never be written to the negative cache - doing so would let a
  // transient outage lock out an already-entitled buyer.
  if (onChain === null) {
    if (cached) {
      const staleMs = now.getTime() - new Date(cached.expiresAt).getTime();

      if (!cached.active) {
        // Extending a stale *negative* result carries no access-control
        // risk (worst case we keep denying a little longer), so it is
        // always safe to fall back to it while the chain is unreachable.
        logger?.warn({ materialId, buyerAddress }, 'Chain verify failed, reusing stale negative cache');
        return { hasAccess: false, source: 'stale-cache-miss' };
      }

      if (staleMs <= STALE_GRACE_MS) {
        // Bounded trust window: keep honoring a recently-expired positive
        // result while the chain is unreachable, so a real outage doesn't
        // immediately cut off already-entitled buyers.
        logger?.warn({ materialId, buyerAddress, staleMs }, 'Chain verify failed, serving bounded-stale positive cache');
        return { hasAccess: true, source: 'stale-cache' };
      }

      // Past the grace window we no longer trust the stale positive result
      // and fail closed rather than granting access indefinitely off data
      // we can no longer verify.
      logger?.error({ materialId, buyerAddress, staleMs }, 'Stale positive entitlement exceeded safe grace window; failing closed');
      return { hasAccess: false, source: 'unavailable-stale-expired' };
    }

    // No cache at all and the chain is unreachable: this is distinct from
    // an authoritative "not found" - we simply don't know. Fail closed but
    // keep the source label distinguishable for observability/alerting.
    logger?.error({ materialId, buyerAddress }, 'Chain verify failed with no cached entitlement to fall back on');
    return { hasAccess: false, source: 'unavailable' };
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
