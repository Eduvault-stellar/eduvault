# Contribution Guide

Thank you for improving EduVault. This guide explains how to prepare changes that are easy to review and safe to merge.

## Development Workflow

1. Create a focused branch for one issue or feature.
2. Install dependencies and configure `.env.local` from `.env.example`.
3. Make the smallest coherent change that satisfies the issue acceptance criteria.
4. Keep documentation in sync when workflows, environment variables, scripts, or APIs change.
5. Run the most relevant checks before committing.
6. Open a pull request with a concise summary, test evidence, and screenshots for visible UI changes.

## Coding Guidelines

- Prefer clear, accessible UI states for loading, empty, error, and success paths.
- Keep marketplace behavior mobile-friendly by default.
- Validate API inputs before writing to MongoDB or external services.
- Do not commit real secrets, private keys, API tokens, or production connection strings.
- Avoid broad refactors in feature branches unless the issue specifically requires them.
- Preserve the distinction between shipped prototype functionality and planned Stellar/Soroban functionality.

## Documentation Guidelines

Update docs when a change affects:

- creator, learner, checkout, or marketplace workflows
- setup steps, required versions, environment variables, or scripts
- API contracts or database collections
- deployment, indexing, backup, or recovery operations
- Stellar/Soroban architecture or integration assumptions

## Testing Expectations

Use the narrowest reliable test first, then broaden as needed:

```bash
npm run check:lockfile
npm run check:licenses
npm run test:backend
npm run test:contracts
npm run scan:secrets
```

For UI work, manually verify the affected route at desktop and mobile widths. Include screenshots in the pull request when the change is visible to users.

## GrantFox Rewards & Deliverable Standards

Contributors working on GrantFox-funded tasks must review the [GrantFox Reward Deliverable Matrix](grantfox-reward-deliverables.md) before starting.

1. **Issue Templates:** Always use the dedicated templates in [`.github/ISSUE_TEMPLATE`](../.github/ISSUE_TEMPLATE) to scope deliverables and verification criteria.
2. **Intent Staking:** Submit a design note in the issue discussion outlining the approach before writing code.
3. **Anti-Mocking Requirement:** Solutions must use genuine logic and real cryptographic primitives. PRs that mock assertions or bypass auth checks are rejected.
4. **Maintainer Review:** PRs must include filled deliverable checklists, passing test logs, and visual evidence before approval.

## Pull Request Checklist

- The PR title clearly describes the user-facing or developer-facing change.
- The PR body explains what changed and why, referencing the deliverable matrix checklist.
- Relevant tests or checks are listed with pass/fail status and command output.
- Screenshots are attached for perceptible UI changes.
- New environment variables are documented in `.env.example` and project docs.
- Database, indexing, or migration impacts are called out explicitly.
- Known follow-up work is documented rather than hidden.
- Payout routing details are included for reward-eligible Web3/Stellar contributions.
