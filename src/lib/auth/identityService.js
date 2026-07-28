
import { getDb } from "@/lib/mongodb";
import { randomUUID } from "crypto";

/**
 * Creates or retrieves a user identity idempotently.
 * This ensures that replaying OAuth callbacks or opening multiple tabs
 * creates exactly one local identity.
 * 
 * @param {string} walletAddress - The wallet address
 * @param {object} providerInfo - OAuth provider info {provider, providerUserId, email, name}
 * @returns {Promise<{user: object, isNew: boolean}>}
 */
export async function getOrCreateIdentity(walletAddress, providerInfo = null) {
  const db = await getDb();
  const users = db.collection("users");
  
  const normalizedAddress = walletAddress.toLowerCase();
  
  // 1. Try to find existing user
  let user = await users.findOne({
    $or: [
      { walletAddress: walletAddress },
      { walletAddressLower: normalizedAddress },
    ],
  });
  
  // 2. If user exists, link new provider if not already linked
  if (user) {
    if (providerInfo) {
      // Check if provider is already linked
      const providerKey = `linkedProviders.${providerInfo.provider}`;
      if (!user.linkedProviders || !user.linkedProviders[providerInfo.provider]) {
        await users.updateOne(
          { uuid: user.uuid },
          {
            $set: {
              [`linkedProviders.${providerInfo.provider}`]: {
                providerUserId: providerInfo.providerUserId,
                email: providerInfo.email,
                name: providerInfo.name,
                linkedAt: new Date(),
              },
              updatedAt: new Date(),
            },
          }
        );
        // Re-fetch updated user
        user = await users.findOne({ uuid: user.uuid });
      }
    }
    return { user, isNew: false };
  }
  
  // 3. Check if there's a user with this email from another provider
  if (providerInfo?.email) {
    const existingByEmail = await users.findOne({
      email: providerInfo.email,
    });
    
    if (existingByEmail) {
      // Link this wallet to the existing account
      await users.updateOne(
        { uuid: existingByEmail.uuid },
        {
          $set: {
            walletAddress: walletAddress,
            walletAddressLower: normalizedAddress,
            updatedAt: new Date(),
            [`linkedProviders.${providerInfo.provider}`]: {
              providerUserId: providerInfo.providerUserId,
              email: providerInfo.email,
              name: providerInfo.name,
              linkedAt: new Date(),
            },
          },
        }
      );
      const updatedUser = await users.findOne({ uuid: existingByEmail.uuid });
      return { user: updatedUser, isNew: false };
    }
  }
  
  // 4. Create new user
  const now = new Date();
  const uuid = randomUUID();
  
  const newUser = {
    uuid,
    walletAddress: walletAddress,
    walletAddressLower: normalizedAddress,
    email: providerInfo?.email || null,
    displayName: providerInfo?.name || null,
    createdAt: now,
    updatedAt: now,
    linkedProviders: providerInfo ? {
      [providerInfo.provider]: {
        providerUserId: providerInfo.providerUserId,
        email: providerInfo.email,
        name: providerInfo.name,
        linkedAt: now,
      }
    } : {},
  };
  
  await users.insertOne(newUser);
  
  // 5. Create onboarding state
  const onboarding = db.collection("onboarding");
  await onboarding.insertOne({
    userId: uuid,
    state: "pending",
    provider: providerInfo?.provider || null,
    providerUserId: providerInfo?.providerUserId || null,
    providerEmail: providerInfo?.email || null,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  
  return { user: newUser, isNew: true };
}

/**
 * Checks if an identity is disabled.
 */
export async function isIdentityDisabled(userId) {
  const db = await getDb();
  const users = db.collection("users");
  const user = await users.findOne({ uuid: userId });
  return user?.status === "disabled";
}
