
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

/**
 * Atomic role provisioning with rollback support.
 * Provisions a role and all associated records in a single transaction.
 * 
 * @param {string} userId - The user's UUID
 * @param {string} role - The role to provision (admin, grantee, payoutProvider)
 * @param {object} roleData - Additional data for the role (e.g., grantee info, payout provider info)
 * @returns {Promise<{success: boolean, result: object, error: string|null}>}
 */
export async function provisionRole(userId, role, roleData = {}) {
  const db = await getDb();
  
  // Start a session for transaction
  const session = db.client.startSession();
  
  try {
    let result = null;
    
    await session.withTransaction(async () => {
      const users = db.collection("users");
      
      // 1. Find the user
      const user = await users.findOne({ uuid: userId }, { session });
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      
      // 2. Check if role is already provisioned
      if (user.role === role) {
        result = { alreadyProvisioned: true, user };
        return;
      }
      
      // 3. Update user with role
      const updateResult = await users.updateOne(
        { uuid: userId },
        { 
          $set: { 
            role: role,
            updatedAt: new Date(),
          }
        },
        { session }
      );
      
      if (updateResult.modifiedCount !== 1) {
        throw new Error(`Failed to update user ${userId} with role ${role}`);
      }
      
      // 4. Create role-specific records
      switch (role) {
        case "grantee":
          await provisionGrantee(db, userId, roleData, session);
          break;
        case "payoutProvider":
          await provisionPayoutProvider(db, userId, roleData, session);
          break;
        case "admin":
          // Admin doesn't need additional records
          break;
        default:
          throw new Error(`Unknown role: ${role}`);
      }
      
      // 5. Update onboarding state
      const onboarding = db.collection("onboarding");
      await onboarding.updateOne(
        { userId },
        { 
          $set: { 
            state: "provisioned",
            selectedRole: role,
            completedAt: new Date(),
            updatedAt: new Date(),
          }
        },
        { session }
      );
      
      // 6. Get the updated user
      const updatedUser = await users.findOne({ uuid: userId }, { session });
      result = { success: true, user: updatedUser };
    });
    
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    await session.endSession();
  }
}

/**
 * Provisions a grantee record.
 */
async function provisionGrantee(db, userId, roleData, session) {
  const grantees = db.collection("grantees");
  
  // Check if grantee already exists
  const existing = await grantees.findOne({ userId }, { session });
  if (existing) return;
  
  const granteeDoc = {
    userId,
    organization: roleData.organization || null,
    website: roleData.website || null,
    description: roleData.description || null,
    walletAddress: roleData.walletAddress || null,
    verified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  await grantees.insertOne(granteeDoc, { session });
}

/**
 * Provisions a payout provider record.
 */
async function provisionPayoutProvider(db, userId, roleData, session) {
  const providers = db.collection("payoutProviders");
  
  // Check if provider already exists
  const existing = await providers.findOne({ userId }, { session });
  if (existing) return;
  
  const providerDoc = {
    userId,
    businessName: roleData.businessName || null,
    payoutWallet: roleData.payoutWallet || null,
    feeRate: roleData.feeRate || 0,
    verified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  await providers.insertOne(providerDoc, { session });
}

/**
 * Gets the current onboarding state for a user.
 */
export async function getOnboardingState(userId) {
  const db = await getDb();
  const onboarding = db.collection("onboarding");
  return await onboarding.findOne({ userId });
}

/**
 * Updates onboarding state with retry tracking.
 */
export async function updateOnboardingState(userId, update, retryOnConflict = true) {
  const db = await getDb();
  const onboarding = db.collection("onboarding");
  
  const result = await onboarding.updateOne(
    { userId },
    { 
      $set: { 
        ...update,
        updatedAt: new Date(),
      },
      $inc: update.state === "failed" ? { retryCount: 1 } : {},
    }
  );
  
  return result;
}
