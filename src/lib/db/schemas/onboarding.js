
/**
 * Onboarding State Schema
 * Tracks the user's progress through the onboarding flow to ensure
 * transactional consistency across OAuth callbacks and role selection.
 * 
 * States:
 * - pending: User initiated onboarding but hasn't completed
 * - role_selected: User selected a role but provisioning pending
 * - provisioned: Role successfully provisioned (final state)
 * - failed: Onboarding failed (with reason)
 * - disabled: User account is disabled
 */
export const OnboardingStateSchema = {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["userId", "state", "createdAt", "updatedAt"],
      properties: {
        userId: {
          bsonType: "string",
          description: "Reference to the user's UUID",
        },
        state: {
          enum: ["pending", "role_selected", "provisioned", "failed", "disabled"],
          description: "Current onboarding state",
        },
        selectedRole: {
          enum: ["admin", "grantee", "payoutProvider"],
          description: "Role selected by the user during onboarding",
        },
        provider: {
          bsonType: "string",
          description: "OAuth provider used (github, google, etc.)",
        },
        providerUserId: {
          bsonType: "string",
          description: "User ID from the OAuth provider",
        },
        providerEmail: {
          bsonType: "string",
          description: "Email from the OAuth provider",
        },
        failedReason: {
          bsonType: "string",
          description: "Reason for failure if state is 'failed'",
        },
        retryCount: {
          bsonType: "int",
          default: 0,
          description: "Number of retry attempts",
        },
        completedAt: {
          bsonType: "date",
          description: "Timestamp when onboarding completed",
        },
        createdAt: {
          bsonType: "date",
          description: "Timestamp when onboarding started",
        },
        updatedAt: {
          bsonType: "date",
          description: "Timestamp of last update",
        },
      },
    },
  },
};

/**
 * Creates an onboarding state record for a new user.
 */
export function createOnboardingState(userId, provider = null, providerUserId = null) {
  const now = new Date();
  return {
    userId,
    state: "pending",
    provider,
    providerUserId,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Checks if an onboarding state is terminal (cannot be changed).
 */
export function isTerminalState(state) {
  return ["provisioned", "disabled"].includes(state);
}
