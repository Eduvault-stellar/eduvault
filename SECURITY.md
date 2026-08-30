# Security Policy

## Reporting a Vulnerability
If you discover a potential security vulnerability, please **do not open a public issue**. Instead, report it privately via email to ensure the safety of our users.

**Email:** security@eduvault.io (or your-email@example.com)

## Security Model
EduVault is a non-custodial platform:
- **Private Keys:** We never store or transmit private keys. Wallet interactions happen client-side via Reown/AppKit.
- **Transactions:** Users must manually approve all on-chain actions.
- **Infrastructure:** Sensitive keys are managed through secure environment variables.

## Refund Signer Controls
Refund payouts move treasury funds, so their signing is isolated from the
general platform admin key:

- **Dedicated key:** `REFUND_SIGNER_SECRET` is a Stellar account used *only*
  for refunds. It never holds more than the treasury float needed for expected
  refund volume and is topped up from cold storage. The general admin secret
  (`STELLAR_ADMIN_SECRET`) can never sign refunds.
- **Least privilege:** The signer performs exactly one operation type — a
  payment to a destination derived from the settled purchase receipt. Amount,
  asset, and destination always come from MongoDB records, never from request
  payloads.
- **Spend ceiling:** `REFUND_MAX_SINGLE_UNITS` caps any single payment.
- **Rotation:** Rotating the key is an environment change; no database state
  references the old key.
- **Emergency disable:** `REFUNDS_EMERGENCY_DISABLE=true` halts all outbound
  refund payments immediately while keeping claims readable and approvable.

## Scope
| Component | Status |
| :--- | :--- |
| EduVault Frontend | In Scope |
| EduVault API Routes | In Scope |
| Smart Contracts | In Scope |
| 3rd Party Services (Clerk, MongoDB) | Out of Scope |

## Disclosure Policy
We commit to acknowledging all reports within 48 hours and will work to resolve valid issues as quickly as possible.