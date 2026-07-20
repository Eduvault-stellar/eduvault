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
npm run lint
npm test
npm run test:backend
npm run test:contracts
npm run scan:secrets
```

For UI work, manually verify the affected route at desktop and mobile widths. Include screenshots in the pull request when the change is visible to users.

## Pull Request Checklist

- The PR title clearly describes the user-facing or developer-facing change.
- The PR body explains what changed and why.
- Relevant tests or checks are listed with pass/fail status.
- Screenshots are attached for perceptible UI changes.
- New environment variables are documented in `.env.example` and project docs.
- Database, indexing, or migration impacts are called out explicitly.
- Known follow-up work is documented rather than hidden.
