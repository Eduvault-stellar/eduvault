# Contributing to EduVault

Thanks for contributing.

## Scope

EduVault is an in-development educational content marketplace with a current web prototype and a planned Stellar-native settlement layer. Contributions should improve one of these areas:

- product clarity
- security
- Soroban contract design
- developer experience
- accessibility
- documentation

## Before You Start

1. Read [README.md](README.md).
2. Review [docs/overview.md](docs/overview.md) and [docs/architecture.md](docs/architecture.md).
3. Open an issue before starting large changes so architecture and scope can be aligned early.

## Local Setup

```bash
npm install
cp .env.example .env.local
docker compose up -d mongodb
npm run dev
```

## Branching

- Use a short descriptive branch name such as `docs/stellar-submission` or `feat/entitlement-checks`.
- Keep pull requests focused. Avoid mixing documentation, refactors, and feature work unless the changes are tightly coupled.

## Coding Standards

- Keep changes small and reviewable.
- Prefer explicit naming over clever abstractions.
- Preserve the distinction between current prototype behavior and planned Stellar milestones.
- Do not claim a feature is on Stellar unless it is implemented and testable in this repository.
- Do not add new product work to the archived EVM prototype unless there is an explicit architecture decision to do so.
- Update documentation when architecture or environment requirements change.

## Pull Request Checklist

- The change is scoped and explained clearly.
- Relevant docs are updated.
- New environment variables are reflected in `.env.example`.
- Pull requests that change visible frontend behavior include screenshots or a short screen recording.
- Request/response examples are included when backend or API changes materially benefit from them.
- Any product or architectural assumptions are stated explicitly in the PR description.

## Commit Messages

Use concise, conventional commit messages when possible:

- `docs: rewrite README for Drip Wave submission`
- `chore: add contributor and license files`
- `docs: document Stellar architecture direction`
- `feat: add Soroban contract scaffolding`

## Reporting Issues

When opening an issue, include:

- expected behavior
- actual behavior
- reproduction steps
- screenshots or logs if relevant
- whether the issue affects the current prototype or the planned Stellar milestone

## Contributor Reward & Issue Workflow (GrantFox / Stellar Wave)

EduVault participates in GrantFox and Stellar ecosystem contributor reward waves. To ensure transparent review standards and fair point allocation, all reward-eligible tasks adhere to a standardized label taxonomy and review process.

### Label Taxonomy & Difficulty Tiers

Issues eligible for FoxPoints / contributor rewards are categorized by complexity and point weight:

| Label | Points | Scope & Complexity |
| :--- | :--- | :--- |
| `difficulty: easy (50 pts)` | **50 pts** | Minor bug fixes, documentation improvements, type annotations, and lightweight helper scripts. |
| `difficulty: medium (100 pts)` | **100 pts** | Standard feature implementations, REST API endpoints, indexer projections, or component refactors. |
| `difficulty: hard (200 pts)` | **200 pts** | Complex Soroban smart contracts, cryptographic authorization, security hardening, or system architecture overhauls. |

### Review Paths & Domain Specialization

Pull requests require domain-specific review based on the nature of the change:

- `review: smart-contract`: Soroban Rust contracts, contract testing, and on-chain state verification.
- `review: frontend`: Next.js / React UI components, Tailwind styling, state management, and accessibility standards.
- `review: backend`: API routes, MongoDB indexing, escrow indexing daemon, and server-side logic.
- `review: security`: Cryptographic signatures, session management, rate limiting, and threat modeling.
- `review: documentation`: Technical guides, API specifications, and architectural diagrams.

### Required Verification Proofs

Before a pull request can be approved and merged, contributors must supply corresponding proof:

- `proof: automated-tests`: Automated unit/integration test suite passing 100% green (`npm test`, `npm run test:backend`, or `npm run test:integration`).
- `proof: ui-recording`: Screenshot or short video recording demonstrating the UI behavior for visible frontend changes.
- `proof: stellar-tx-hash`: Testnet transaction hash or Horizon / Soroban RPC simulation output for blockchain interactions.

### Claim & Assignment Protocol

1. **Find an eligible issue**: Browse issues tagged with `reward: eligible`.
2. **Post a brief proposal**: Comment on the issue with:
   - Your proposed implementation approach.
   - The relevant review path and proof artifacts you will provide.
3. **Assignment SLA**:
   - Maintainers will assign the issue and add `reward: claimed`.
   - Each contributor may only have **one active assigned issue** at a time.
   - Contributors must open a draft PR or submit an initial commit within **48 hours** of assignment. Inactive assignments may be reassigned.

### Maintainer Triage & Lifecycle Rules

The issue lifecycle progresses through deterministic states:

```
[reward: eligible] ──(Claimed)──> [reward: claimed] ──(PR Opened)──> [reward: in-review]
                                                                            │
[reward: completed] <──(Merged)── [reward: verified] <──(Proof Validated)───┘
```

1. **Triage**: Maintainer verifies issue clarity, sets difficulty and review path labels, and applies `reward: eligible`.
2. **Claim**: On assignment, label updates to `reward: claimed`.
3. **Review**: Contributor opens PR with closing keyword (`closes #<id>`); label updates to `reward: in-review`.
4. **Verification**: CI passes and verification proof artifacts are checked; label updates to `reward: verified`.
5. **Completion**: PR is merged; issue is closed and marked `reward: completed`.

## Security

Do not disclose secrets, private keys, or production credentials in issues or pull requests. If you discover a sensitive security issue, contact the maintainer privately before public disclosure.
🌟 Stellar Contributors: See the [Stellar Integration Guide](docs/STELLAR_GUIDE.md) for setup instructions.