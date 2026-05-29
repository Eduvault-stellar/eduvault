import { getDb } from '@/lib/mongodb';
import { NETWORK_PASSPHRASE } from '@/lib/config/chain';
import { Transaction, xdr, Keypair } from '@stellar/stellar-sdk';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_CLEANUP_INTERVAL_MS = 60 * 1000;

function generateNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getChallengeMessage(nonce, address) {
  return `EduVault Login\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${Date.now()}`;
}

export async function issueChallenge(address) {
  const db = await getDb();
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  const doc = {
    address: address.toLowerCase(),
    nonce,
    expiresAt,
    used: false,
    createdAt: new Date(),
  };

  await db.collection('auth_challenges').insertOne(doc);

  return {
    nonce,
    address,
    expiresAt: expiresAt.toISOString(),
    message: getChallengeMessage(nonce, address),
  };
}

export async function verifyChallenge(address, nonce, signedTransactionXdr) {
  const db = await getDb();
  const challenge = await db.collection('auth_challenges').findOne({
    address: address.toLowerCase(),
    nonce,
    used: false,
    expiresAt: { $gt: new Date() },
  });

  if (!challenge) {
    return { valid: false, reason: 'Challenge not found, expired, or already used' };
  }

  try {
    const tx = Transaction.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);

    const txSource = tx.source;
    if (txSource !== address) {
      await markChallengeUsed(db, challenge._id);
      return { valid: false, reason: 'Transaction source does not match claimed address' };
    }

    const memo = tx.memo?.value?.toString() ?? '';
    if (memo !== nonce) {
      await markChallengeUsed(db, challenge._id);
      return { valid: false, reason: 'Transaction memo does not match challenge nonce' };
    }

    const txHash = tx.hash().toString('hex');
    const isSigned = tx.signatures.some((sig) => {
      try {
        const keypair = Keypair.fromPublicKey(address);
        return keypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    await markChallengeUsed(db, challenge._id);

    if (!isSigned) {
      return { valid: false, reason: 'Invalid signature' };
    }

    return { valid: true };
  } catch (err) {
    await markChallengeUsed(db, challenge._id).catch(() => {});
    return { valid: false, reason: `Verification failed: ${err.message}` };
  }
}

async function markChallengeUsed(db, id) {
  await db.collection('auth_challenges').updateOne(
    { _id: id },
    { $set: { used: true, usedAt: new Date() } }
  );
}

export async function cleanupExpiredChallenges() {
  try {
    const db = await getDb();
    await db.collection('auth_challenges').deleteMany({
      expiresAt: { $lt: new Date() },
    });
  } catch {
  }
}
