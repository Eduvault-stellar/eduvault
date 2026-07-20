# Soroban Upgrade Pattern (EduVault)

This document defines the upgrade strategy used by EduVault Soroban contracts.

## Pattern Selected

EduVault uses **admin-gated Wasm hash replacement** through:

- `env.deployer().update_current_contract_wasm(new_wasm_hash)`

This keeps the **same contract ID and storage**, while updating executable logic.

## Implementation

### `purchase-manager`

```rust
pub fn upgrade(
    env: Env,
    admin: Address,
    new_wasm_hash: BytesN<32>,
) -> Result<(), PurchaseError> {
    admin.require_auth();
    verify_admin(&env, &admin)?;
    env.deployer().update_current_contract_wasm(new_wasm_hash);
    Ok(())
}
```

- The `Admin` key is stored persistently during `initialize`.
- `verify_admin` compares the caller against the stored admin address and returns `NotAuthorized` on mismatch.
- Only the admin account can invoke `upgrade`.

### `material-registry`

Uses the same pattern under a dedicated `UpgradeAdmin` key bootstrapped on first registration. The upgrade admin can be transferred via `set_upgrade_admin`.

## Security Controls

- Upgrade entrypoints require:
  - explicit signer auth (`admin.require_auth()`)
  - persistent admin match checks (`NotAuthorized` on mismatch)
- Non-admin callers receive `PurchaseError::NotAuthorized`.
- All three properties are covered by tests in `src/test.rs` (`upgrade_rejected_for_non_admin`, `upgrade_requires_admin_auth`, `state_preserved_after_upgrade`).

## State Compatibility Rules

To keep upgrades safe:

1. Never reorder or rename `DataKey` variants already in use.
2. Only append new variants and fields in backward-compatible ways.
3. Keep storage value layouts stable across upgrades.
4. Add migration hooks (if required) behind admin-only endpoints.

## Operational Rollout

1. Build and verify new Wasm in CI (`cargo test`, release build).
2. Run pre-upgrade checklist (state schema compatibility + tests).
3. Submit admin-authorized upgrade transaction with new Wasm hash.
4. Validate post-upgrade contract behavior using integration tests and read checks.

## Why This Approach

- No proxy indirection overhead.
- Contract ID remains stable for app integrations.
- Works with Soroban-native deployment flow.
- Enables future governance hardening (e.g., multisig admin account).
