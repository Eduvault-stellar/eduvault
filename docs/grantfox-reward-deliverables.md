# GrantFox Reward Deliverable Matrix & Review Standards

## 1. Overview

EduVault partners with GrantFox to reward open-source contributions across our educational marketplace and Stellar-native settlement layer. To ensure transparency, prevent disputes, and maintain production-grade security, all reward-eligible issues must adhere to strict deliverable mappings, verification requirements, and maintainer review gates.

This guide outlines the standard expectations for every contribution tier before work begins, during execution, and through pull request review.

---

## 2. Contributor Lifecycle & Reward Eligibility

Every reward-eligible task progresses through six discrete phases:

| Phase | Action | Required Artifacts |
|---|---|---|
| **1. Qualification** | Verify repository status, fund confirmation, and ensure no active competitor claims exist. | GitHub issue status, lack of assigned contributor or competing PR. |
| **2. Intent Staking** | Post a preliminary design note in the issue discussion before writing code. | Issue comment with root cause analysis, planned architecture, and test strategy. |
| **3. Execution** | Implement solution locally on a dedicated branch (`fix-issue-<id>`). | Code changes conforming to repository standards; no mocked tests or loosened assertions. |
| **4. Verification** | Run required quality gates, regression suites, and capture visual evidence. | Passing test logs, linter outputs, lockfile validation, and screenshots. |
| **5. Pull Request** | Open a Draft PR against `upstream/main` with the deliverable checklist and payout routing block. | Draft PR with filled deliverable matrix and test evidence. |
| **6. Review & Payout** | Maintainer review and automated CI validation prior to merge and reward distribution. | Approved GitHub review, passing CI checks, GrantFox settlement confirmation. |

---

## 3. Deliverable Matrix by Technology Stack

All issues must map to specific measurable deliverables based on their target technological domain.

### 3.1 Frontend (Next.js, React, Tailwind, UI)
- **Viewport Responsiveness**: Components and pages must render correctly on both desktop (1280px+) and mobile (375px+) screens without layout breakage or unintended overflow.
- **Accessibility (A11y)**: Must satisfy WCAG 2.2 AA standards. Semantic HTML elements must be used (`<main>`, `<nav>`, `<button>`), color contrast ratios must meet minimum thresholds (4.5:1 for normal text), all interactive elements must have visible keyboard focus indicators, and custom controls must include appropriate ARIA attributes.
- **Visual Verification Artifacts**: Any change modifying visible user interfaces must include before and after screenshots or an animated screen recording attached directly to the pull request.
- **State Handling**: Loading, empty, error, and success states must be explicitly handled in UI components.

### 3.2 Backend API (Node.js, Express, MongoDB, Pinata/IPFS)
- **Input Validation & Sanitization**: All endpoint inputs (`params`, `query`, `body`) must be validated with fail-closed semantics before reaching business logic or database queries.
- **Server-Side Authorization**: Endpoints handling privileged operations (admin actions, purchases, uploads, user suspensions) must enforce authentication and role claims on the server side via session or JWT tokens. Never rely on client-side state for access control.
- **Contract & Spec Alignment**: Updates modifying request or response shapes must be synchronized with `docs/openapi.yaml` and client generators (`scripts/generate-api-client.mjs`).
- **Data Protection & Storage**: Sensitive PII and secrets must never be written to logs or persisted in unencrypted forms. File uploads must adhere to MIME allowlists and byte header verification.

### 3.3 Soroban Smart Contracts (Rust, Soroban SDK, Stellar)
- **Mandatory Authorization**: All state-modifying contract functions must invoke `require_auth()` for the appropriate caller address or entity.
- **True Cryptographic Primitives**: Cryptographic signatures, verification, and host functions must use genuine SDK methods. Mocking, stubbing, or faking proofs is strictly prohibited.
- **Resource Bounds**: All caller-supplied vectors, byte strings, and collection parameters must have strict maximum length bounds enforced to prevent ledger resource exhaustion.
- **Test Coverage**: Smart contract logic must be verified using native tests (`npm run test:contracts` or `cargo test`).

### 3.4 Documentation & Infrastructure
- **Documentation Parity**: Architectural modifications, lifecycle changes, and new runbooks must be documented in `docs/` in real time.
- **Environment Configuration**: Any new environment variable introduced must be accompanied by non-secret placeholders in `.env.example` and documentation in `docs/environment-setup.md`.
- **Lockfile & Dependency Integrity**: Dependencies must pass license scanning (`npm run check:licenses`) and lockfile verification (`npm run check:lockfile`).

### 3.5 Testing & Quality Assurance
- **Regression Proof**: Bug fixes must include a focused regression test that reproduces the failure before the patch is applied.
- **Preservation of Assertions**: Existing test suite assertions must never be commented out, deleted, or weakened to force passes.
- **Secret Scanning**: All code and test files must pass secret scanning (`npm run scan:secrets`) with zero committed credentials or sensitive tokens.

---

## 4. Required Verification Artifacts

Every pull request must document the concrete verification commands executed and attach matching evidence:

```bash
# Core verification sequence
npm run check:lockfile
npm run check:licenses
npm run test:backend
npm run scan:secrets
```

When changes touch specific subsystems, the respective test commands must also be provided:
- Contracts: `npm run test:contracts`
- Integration: `npm run test:integration`
- UI Changes: Attached screenshots or video demonstrations showing responsive views and keyboard interaction.

---

## 5. Security & Privacy Review Gates

Maintainers will evaluate the following security checkpoints during review:

1. **Authentication Fail-Closed**: Unauthenticated, expired, or malformed requests must immediately terminate with 401 or 403 responses.
2. **SSRF & Webhook Protection**: Outbound webhook dispatchers must validate URLs against private IP allowlists and reject internal network ranges.
3. **Data Redaction**: Telemetry, logs, and webhook history records must redact authorization headers, bearer tokens, and PII before persistence.
4. **Idempotency**: Payout, refund, and purchase operations must incorporate idempotency keys or state checks to prevent double-spending.

---

## 6. Maintainer Review & Settlement Workflow

1. **Draft PR Submission**: Contributors open a Draft PR containing the deliverable checklist and test evidence.
2. **Automated Quality Checks**: All GitHub Actions CI checks (linting, build, backend tests, contract tests, migrations) must report green.
3. **Maintainer Audit**: Maintainers review code quality, test rigor, and adherence to repository architecture.
4. **Readiness Transition**: Once approved, the Draft PR is marked "Ready for Review" and merged.
5. **GrantFox Reward Settlement**: Following merge, the maintainer marks the issue completed on GrantFox, awarding the corresponding campaign points and triggering token distribution to the contributor's registered payout address.
