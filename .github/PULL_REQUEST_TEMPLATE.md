## Summary

Brief summary of the changes introduced by this pull request and the issue it addresses.

Fixes # / Closes #

---

## Deliverable Matrix Checklist

Confirm deliverables completed as part of this contribution:

### Frontend
- [ ] Responsive UI verified on mobile and desktop viewports.
- [ ] Accessibility standards verified (WCAG 2.2 AA, semantic HTML, keyboard focus, ARIA attributes).
- [ ] Before/after screenshots or screen recording attached for visible UI changes.

### Backend API
- [ ] Input validation and sanitization implemented with fail-closed semantics.
- [ ] Server-side authorization enforced via session/JWT verification.
- [ ] OpenAPI specifications and client contracts synchronized.
- [ ] Backend tests passing cleanly (`npm run test:backend`).

### Soroban Smart Contracts
- [ ] Authorization checks enforced on state modifications using `require_auth()`.
- [ ] Vectors, bytes, and caller inputs bounded to prevent resource exhaustion.
- [ ] Contract tests passing (`npm run test:contracts` or `cargo test`).

### Documentation & Setup
- [ ] Architecture, project workflows, or guides updated in `docs/`.
- [ ] Environment variables updated in `.env.example` if applicable.

### Testing & QA
- [ ] Regression / reproduction test included reproducing the bug or gap before the fix.
- [ ] All assertions run without mocks or bypassed test checks.
- [ ] Secrets scan passes (`npm run scan:secrets`).
- [ ] Lockfile integrity verified (`npm run check:lockfile`).

---

## Verification Artifacts

### Test Commands Executed
```bash
npm run check:lockfile
npm run test:backend
npm run scan:secrets
```

### Test Logs / Evidence
```text
[Paste terminal test summary or execution logs here]
```

### Visual Evidence (UI Changes)
<!-- Attach screenshots or video demonstrating visual or interactive changes -->

---

## Security & Privacy Considerations

- **Authorization Checks:**
- **Data Protection & Sanitization:**
- **Zero Secrets Disclosure:** Confirmed no private keys, API secrets, or credentials committed.

---

## Payout Routing
- **EVM (Base/Arbitrum/Polygon/ETH):** `0xF46C9F6d70C50BF81ef3588AB523a90a594a2F89`
- **Stellar:** `GCL6OXAMLD75BMTINA6EMRUDWK5THQUSHMYNLSNBCJAPZJHNYJTUNIBC`
