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

## GrantFox Rewards & Deliverable Standards

EduVault participates in GrantFox bounty campaigns. All reward-eligible tasks must adhere to our standardized deliverable matrix:

- **Issue Templates:** New reward issues and bug reports must use the structured templates in [`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE).
- **Deliverable Matrix:** Refer to [GrantFox Reward Deliverable Matrix](docs/grantfox-reward-deliverables.md) for detailed expectations across Frontend, Backend API, Soroban Contracts, Documentation, and Testing.
- **Pre-Flight Conditions:** Contributors must ensure the issue is unclaimed and post a preliminary design note in the issue discussion before starting technical work.
- **Zero Mocking:** Solutions must implement true business logic. Mocking cryptographic primitives, stubbing authorization checks, or weakening test assertions will disqualify a contribution.
- **Maintainer Review Gates:** Maintainers require all CI checks to pass, lockfile integrity verification, documentation synchronization, and terminal test logs or UI screenshots attached to the pull request before approving rewards.

## Reporting Issues

When opening an issue, use the appropriate template in [`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE):

- **GrantFox Reward Tasks:** Use the GrantFox Reward Task template to specify target domain, deliverables checklist, test plan, and security notes.
- **Bug Reports:** Provide clear reproduction steps, expected versus actual behavior, and relevant logs or screenshots.
- **Feature Requests:** Detail the motivation, proposed solution, and architectural tradeoffs.

## Security

Do not disclose secrets, private keys, or production credentials in issues or pull requests. If you discover a sensitive security issue, contact the maintainer privately before public disclosure.

Stellar Contributors: See the [Stellar Integration Guide](docs/STELLAR_GUIDE.md) for setup instructions.