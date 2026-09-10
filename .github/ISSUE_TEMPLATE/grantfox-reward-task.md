---
name: GrantFox Reward Task (Markdown)
about: Standardized markdown template mapping work to measurable deliverables, tests, and verification artifacts.
title: "[Reward]: <Short descriptive summary>"
labels: ["GrantFox OSS", "Maybe Rewarded"]
assignees: []
---

## Problem

Provide a clear statement of the problem, affected components, and user or marketplace impact.

## Domain & Complexity

- **Target Domain:** [Frontend | Backend API | Soroban Smart Contracts | Documentation | Testing & QA | Operations & Infrastructure]
- **Complexity Tier:** [Low - 50 points | Medium - 100 points | High - 200 points | Critical - 300+ points]

## Scope

- In-Scope:
  - 
- Out-of-Scope:
  - 

## Reward Eligibility Pre-Flight Checklist

Before claiming or starting technical work on this issue, verify the following conditions:

- [ ] Repository is confirmed active and not archived.
- [ ] Issue is unclaimed with no active competitor pull requests or assignment.
- [ ] A design note summarizing root cause and planned technical solution has been posted to the issue discussion.
- [ ] Solution implements genuine logic without mocked cryptographic primitives or loosened assertions.
- [ ] Zero sensitive credentials, private keys, or API secrets will be introduced.

## Domain Deliverable Matrix

Check all deliverable items that apply to this task:

### Frontend
- [ ] Responsive layout verified on desktop and mobile breakpoints.
- [ ] Accessibility standards met (WCAG 2.2 AA compliance, semantic HTML, keyboard focus, ARIA tags).
- [ ] Before/after screenshots or screen recording attached for visible UI modifications.

### Backend API
- [ ] Input validation and sanitization implemented with fail-closed semantics.
- [ ] Server-side authorization and session/JWT claims verified (no client-side privilege trusts).
- [ ] OpenAPI / schema contracts updated and kept in sync.
- [ ] Backend tests passing (`npm run test:backend`).

### Soroban Smart Contracts
- [ ] Authorization enforced on all state-modifying functions via `require_auth()`.
- [ ] Resource bounds enforced on vectors, byte strings, and caller inputs.
- [ ] Contract tests passing (`cargo test` or `npm run test:contracts`) using genuine host functions.

### Documentation
- [ ] Architecture, project workflows, or runbooks updated in `docs/`.
- [ ] New configuration variables reflected in `.env.example`.

### Testing & QA
- [ ] Focused reproduction or regression test added proving the baseline bug/gap.
- [ ] Full test suite passes without skipping or disabling existing assertions.
- [ ] Secret scanner passes (`npm run scan:secrets`).

## Verification Artifacts & Test Plan

Document the exact commands executed and evidence required:

```bash
# Example verification commands
npm run check:lockfile
npm run test:backend
npm run scan:secrets
```

- **Required Output Logs:** [Attach command terminal outputs]
- **Visual Evidence:** [Attach screenshots/recording for frontend changes]

## Security & Privacy Notes

- **Trust Boundaries:** 
- **Authorization Enforcement:** 
- **Data Protection & Sanitization:** 

## Maintainer Review & Acceptance Expectations

- Atomic git commits with conventional commit messaging.
- Pull request opened as Draft initially with deliverable checklist embedded.
- All CI workflows passing cleanly.
- Maintainer reviews code for architectural consistency and security boundaries before reward approval.
