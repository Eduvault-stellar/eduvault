# Testing Guide

This document outlines the testing strategy, test execution commands for local development versus CI pipelines, and a comprehensive debugging guide for end-to-end (E2E) test failures.

---

## 1. Running Tests: Local vs. CI

### Test Suites Overview

| Suite | Command | Runner / Framework | Purpose |
| :--- | :--- | :--- | :--- |
| **E2E Tests** | `npm run test:e2e` | Playwright | Multi-role user journeys, dummy wallet adapter, cache invalidation, timeout recovery |
| **E2E UI Mode** | `npm run test:e2e:ui` | Playwright UI | Interactive step-by-step UI runner with time travel |
| **Unit & Integration** | `npm test` | Vitest | Component testing, hook isolation, utilities, schema checks |
| **Backend Integration** | `npm run test:backend` | Node.js Test Runner | API endpoint security, RBAC policies, indexing, database migrations |
| **Smart Contracts** | `npm run test:contracts` | Hardhat | Smart contract compilation and verification |
| **All Test Suites** | `npm run test:all` | Combined | Runs contract and backend integration suites |

---

### Local Execution

In local development, test runners default to fast feedback with parallel workers and zero retries:

```bash
# Run all E2E tests across default projects
npm run test:e2e

# Run a specific E2E test file
npx playwright test tests/e2e/funding-journey.spec.ts

# Run tests on a specific project/browser
npx playwright test --project=desktop-chrome

# Run unit and integration tests
npm test

# Run backend test suite
npm run test:backend
```

---

### Continuous Integration (CI)

In CI (`CI=true`), the testing configuration automatically adjusts for deterministic execution and artifact hygiene:

```bash
# CI execution command
npm run test:e2e
```

**Key CI Behaviors (`playwright.config.ts`):**
- **Deterministic Workers**: Runs with a single worker (`workers: 1`) to eliminate race conditions.
- **Flake Retries**: Configured for 2 retries (`retries: 2`) with the custom `FlakeReporter` surfacing retry warnings in PR annotations.
- **Zero-Leak Artifact Retention**: Traces, screenshots, and videos are captured **only on failure** (`retain-on-failure`) and discarded on passing runs so sensitive tokens or PII are never retained.
- **Headless Execution**: Enforces `headless: true` across desktop, tablet, and mobile viewports.

---

## 2. Debugging Guide

When an E2E test fails or exhibits flaky behavior, use the following debugging workflows to isolate the issue.

---

### 1. Running in Headed Mode (`--headed`)

By default, Playwright runs tests in headless mode. To watch browser interactions in real-time with a visible browser window, append `--headed`:

```bash
# Run all E2E tests in headed mode
npx playwright test --headed

# Run a specific test in headed mode on Desktop Chrome
npx playwright test tests/e2e/funding-journey.spec.ts --project=desktop-chrome --headed

# Slow down execution (e.g. 500ms between actions) to observe UI transitions
npx playwright test tests/e2e/timeout-recovery.spec.ts --headed --slow-mo=500
```

---

### 2. Viewing Traces (`show-trace`)

When a test fails, Playwright saves a complete trace file under the `test-results/` directory (e.g. `test-results/<test-name>/trace.zip`).

The Playwright Trace Viewer provides:
- DOM snapshots before and after every action.
- Network activity (requests, intercepted routes, responses, timing).
- Console logs and browser events.
- Action-by-action timeline scrubbing.

#### Opening a Trace:

```bash
# Open a specific trace file
npx playwright show-trace test-results/funding-journey-Funding-Journey-desktop-chrome/trace.zip

# Alternatively, pass the path directly
npx playwright show-trace ./test-results/<failed-test-folder>/trace.zip
```

#### Viewing the HTML Test Report:

```bash
# Open the complete Playwright HTML report containing embedded traces and failure logs
npx playwright show-report
```

---

### 3. Interactive UI Mode (`--ui`)

Playwright UI mode provides a live, interactive environment with DOM inspection, console logs, and step filtering:

```bash
# Launch Playwright interactive UI runner
npm run test:e2e:ui

# Or launch directly via npx
npx playwright test --ui
```

---

### 4. Interactive Debugger (`--debug`)

To pause execution on failure or step through tests line-by-line using the Playwright Inspector:

```bash
# Launch the Playwright Inspector
npx playwright test tests/e2e/cache-invalidation.spec.ts --debug
```

In debug mode, you can:
- Step over actions (`F10`).
- Resume execution (`F5`).
- Click "Explore" to test locator selectors interactively in the browser.

---

### 5. Mocking & Fixture Debugging

The E2E test suite uses deterministic fixtures in `e2e/fixtures`:
- **Dummy Wallet Adapter** (`e2e/adapters/dummy-wallet-adapter.ts`): Bypasses real Stellar wallet popups and auto-approves transaction signatures deterministically.
- **Network Interception** (`e2e/helpers/network-interception.ts`): Routes all calls to `**/trustless-work-api/**` and Stellar Soroban JSON-RPC/Horizon endpoints.
- **Mock JSON Responses** (`e2e/helpers/mock-responses.ts`): Provides pre-configured payloads for successful funding, delayed network confirmations, and rejected signatures.
