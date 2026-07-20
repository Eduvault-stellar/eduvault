# PR Description

## Overview
This PR implements critical operational safety and compliance features for the EduVault marketplace, including contract pause/unpause functionality, geolocation-based tax estimation, and verification of existing multi-destination payout and platform fee collection features.

## Changes

### Task 1: Add pause/unpause operational safety toggles (#310)
**File:** `soroban/contracts/purchase-manager/src/lib.rs`

- Added dedicated `pause()` function to temporarily halt all state-modifying contract operations
- Added dedicated `unpause()` function to resume normal operations
- Both functions are admin-only and emit `PlatformConfigUpdatedEvent` for transparency
- The existing `set_platform_config()` already supported pause functionality, but these dedicated functions provide clearer operational safety controls
- When paused, the `purchase()` function returns `PurchaseError::ContractPaused`

**Acceptance Criteria:**
- ✅ Transactions fail if contract is paused (existing check at line 367-369)
- ✅ Only administrators can pause/unpause (admin verification at lines 623 and 647)

### Task 2: Implement geolocation checking for tax estimation APIs (#299)
**Files:** 
- `src/lib/checkout/taxEstimator.js` (new)
- `src/app/api/checkout/initiate/route.js` (new)

**taxEstimator.js:**
- Implemented `estimateTax()` function that resolves geolocation from IP address using ip-api.com
- Added comprehensive tax rate database for 40+ countries (stored in basis points)
- Implemented `calculateTaxAmount()` for precise tax calculations
- Added `applyTaxToCheckout()` to integrate tax estimation into checkout flow
- Included `isValidTaxRate()` validation function (max 30% tax rate)
- Supports manual country code override or automatic IP-based detection

**checkout/initiate/route.js:**
- Created POST endpoint to initiate checkout with tax estimation
- Automatically extracts buyer IP from request headers (x-forwarded-for, x-real-ip)
- Stores checkout intents in MongoDB with 30-minute expiration
- Returns complete tax breakdown including base amount, tax rate, tax amount, and total
- Created GET endpoint for tax estimation without creating checkout intent

**Acceptance Criteria:**
- ✅ Geolocation resolver estimates tax based on IP queries
- ✅ Totals in invoice payload are adjusted correctly (originalAmount + taxAmount = totalAmount)

### Task 3: Implement multi-destination payout splits in Soroban contract (#306)
**File:** `soroban/contracts/purchase-manager/src/lib.rs`

**Verification:** This feature is already fully implemented in the contract:
- `PayoutShare` structure (lines 52-58) defines recipient and share_bps
- `MaterialRecord` includes `payout_shares: Vec<PayoutShare>` (line 69)
- `validate_payout_shares()` (lines 699-733) validates:
  - Share count between 1-5 recipients
  - Individual shares between 0-10000 basis points
  - Total shares equal exactly 10000 basis points (100%)
  - No duplicate recipients
- `distribute_payout_shares()` (lines 735-787) executes:
  - Calculates each recipient's share percentage
  - Uses last-recipient-remainder strategy to prevent dust token leaks
  - Transfers tokens to each recipient via SAC interface
  - Emits `PayoutDistributedEvent` for each payout
- Integration in `purchase()` function (lines 433-441) calls distribution after platform fee collection

**Acceptance Criteria:**
- ✅ Payments are split correctly based on defined ratios (lines 753-758)
- ✅ Contracts reject invalid payout splits (lines 699-733, totals must equal 100%)

### Task 4: Add contract platform fee deduction collection rules (#308)
**File:** `soroban/contracts/purchase-manager/src/lib.rs`

**Verification:** This feature is already fully implemented in the contract:
- `PlatformConfig` includes `platform_fee_bps` field (line 78) and `treasury` address (line 77)
- `MAX_PLATFORM_FEE_BPS` constant limits fee to 10% (line 9)
- Platform fee calculation in `purchase()` (lines 407-409):
  - `platform_fee = (gross * platform_fee_bps) / BASIS_POINTS`
  - `seller_net = gross - platform_fee`
- Platform fee transfer (lines 417-430):
  - Transfers fee to treasury address via SAC
  - Emits `PayoutDistributedEvent` with role "platform_fee"
- Validation during initialization (lines 313-316) and config updates (lines 542-545)
- Treasury validation prevents self-transfer (lines 319-321, 548-550)

**Acceptance Criteria:**
- ✅ Platform wallet destination address defined in config
- ✅ Platform fee calculated on purchase execution (lines 407-409)
- ✅ Platform fee transferred to treasury, creator share to recipients (lines 417-441)

## Testing Recommendations

### Smart Contract Tests
- Test pause/unpause functions with admin and non-admin accounts
- Verify purchases fail when paused
- Test multi-destination payout splits with various configurations
- Verify platform fee calculation and transfer accuracy

### Backend Tests
- Test tax estimation with known IP addresses
- Verify tax rate database accuracy
- Test checkout initiation with and without tax
- Test geolocation fallback behavior

## Security Considerations
- Pause/unpause functions are admin-only with proper authentication
- Tax rates are capped at 30% to prevent excessive charges
- Platform fees are capped at 10% during initialization
- Payout shares validate total equals 100% to prevent fund loss
- Dust token prevention via last-recipient-remainder strategy

## Breaking Changes
None. All changes are additive or verify existing functionality.

Closes #310, #299, #306, #308
