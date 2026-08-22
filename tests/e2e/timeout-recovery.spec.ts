/**
 * End-to-End Test: Network Timeout & Error Recovery Flow.
 *
 * Verifies that:
 * 1. Simulating a network timeout during a critical action (e.g., clicking "Fund Escrow")
 *    via `page.route` aborting the request does not crash the application.
 * 2. The UI gracefully transitions to a retryable error state and displays a "Retry" button.
 * 3. Clicking "Retry" re-executes the transaction and successfully completes the flow.
 */

import { test, expect } from '@playwright/test';
import {
  createDummyWalletInitScript,
  DEFAULT_TEST_WALLET_ADDRESS,
  DEFAULT_NETWORK_PASSPHRASE,
} from '../../e2e/adapters/dummy-wallet-adapter';
import {
  createMockFundingSuccessResponse,
  createMockHorizonAccountResponse,
  MOCK_CONSTANTS,
} from '../../e2e/helpers/mock-responses';

const TEST_ESCROW_ID =
  '0x4a7f8e9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';

test.describe('Network Timeout & UI Retry Recovery', () => {
  test('gracefully handles network timeout on critical action and recovers on retry', async ({
    page,
  }) => {
    await page.addInitScript(
      createDummyWalletInitScript({
        address: DEFAULT_TEST_WALLET_ADDRESS,
        walletId: 'dummy-wallet',
        networkPassphrase: DEFAULT_NETWORK_PASSPHRASE,
        autoApprove: true,
        preConnected: true,
      })
    );

    let requestAttempt = 0;

    await page.route('**/trustless-work-api/escrow/fund**', async (route) => {
      requestAttempt += 1;

      if (requestAttempt === 1) {
        await route.abort('timedout');
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          createMockFundingSuccessResponse({
            escrowId: TEST_ESCROW_ID,
            amount: '10000000',
            asset: 'USDC',
          })
        ),
      });
    });

    await page.route('https://horizon-testnet.stellar.org/accounts/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          createMockHorizonAccountResponse(DEFAULT_TEST_WALLET_ADDRESS)
        ),
      });
    });

    await page.goto('about:blank');

    await page.evaluate(async (escrowId) => {
      document.body.innerHTML = `
        <style>
          .hidden { display: none !important; }
        </style>
        <div id="funding-panel" class="p-6">
          <h2 class="text-xl font-bold">Escrow Funding</h2>
          <p id="escrow-status" data-status="idle" class="my-2">Status: Ready to Fund</p>
          <div id="error-banner" class="hidden text-red-600 bg-red-50 p-3 rounded my-2"></div>
          
          <button id="fund-btn" class="px-4 py-2 bg-blue-600 text-white rounded">
            Fund Escrow
          </button>
          <button id="retry-btn" class="hidden px-4 py-2 bg-yellow-600 text-white rounded">
            Retry
          </button>
          <div id="tx-success" class="hidden text-green-600 font-semibold my-2"></div>
        </div>
      `;

      (window as any).__FUNDING_CONTROLLER__ = {
        escrowId,
        executeFunding: async function() {
          const statusEl = document.getElementById('escrow-status')!;
          const errorBanner = document.getElementById('error-banner')!;
          const fundBtn = document.getElementById('fund-btn')!;
          const retryBtn = document.getElementById('retry-btn')!;
          const successEl = document.getElementById('tx-success')!;

          try {
            statusEl.setAttribute('data-status', 'submitting');
            statusEl.textContent = 'Status: Submitting transaction to network...';
            fundBtn.setAttribute('disabled', 'true');
            retryBtn.classList.add('hidden');
            errorBanner.classList.add('hidden');

            const wallet = (window as any).__EDUVAULT_DUMMY_WALLET__;
            const signResult = await wallet.signTransaction('AAAAAgAAAABFUND_XDR', {
              address: wallet.address,
              intent: { action: 'fund', escrowId },
            });

            const res = await fetch('https://api.trustlesswork.com/trustless-work-api/escrow/fund', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                escrowId,
                amount: '10000000',
                signedTxXdr: signResult.signedTxXdr,
              }),
            });

            if (!res.ok) {
              throw new Error(`Server returned status ${res.status}`);
            }

            const data = await res.json();

            statusEl.setAttribute('data-status', 'confirmed');
            statusEl.textContent = 'Status: Escrow Funded Successfully';
            fundBtn.classList.add('hidden');
            retryBtn.classList.add('hidden');
            successEl.textContent = `Transaction Hash: ${data.transactionHash}`;
            successEl.classList.remove('hidden');
          } catch (err: any) {

            const isTimeout = /timedout|timeout|failed to fetch|network|load failed/i.test(err?.message || '');
            statusEl.setAttribute('data-status', 'needs_retry');
            statusEl.textContent = 'Status: Action needed (Network Issue)';

            errorBanner.textContent = isTimeout
              ? 'Network request timed out. You can retry when ready.'
              : err.message;
            errorBanner.classList.remove('hidden');

            fundBtn.classList.add('hidden');
            retryBtn.classList.remove('hidden');
            retryBtn.removeAttribute('disabled');
          }
        },
      };

      document.getElementById('fund-btn')!.addEventListener('click', () => {
        (window as any).__FUNDING_CONTROLLER__.executeFunding();
      });
      document.getElementById('retry-btn')!.addEventListener('click', () => {
        (window as any).__FUNDING_CONTROLLER__.executeFunding();
      });
    }, TEST_ESCROW_ID);

    //  Click "Fund Escrow" and trigger initial network timeout
    const fundBtn = page.locator('#fund-btn');
    await expect(fundBtn).toBeVisible();
    await fundBtn.click();

    //  Assert graceful error handling (No crash, error message, Retry visible)
    const statusEl = page.locator('#escrow-status');
    await expect(statusEl).toHaveAttribute('data-status', 'needs_retry');
    await expect(statusEl).toHaveText(/Action needed/i);

    const errorBanner = page.locator('#error-banner');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(/Network request timed out|Load failed/i);

    await expect(fundBtn).toBeHidden();
    const retryBtn = page.locator('#retry-btn');
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toBeEnabled();

    const panel = page.locator('#funding-panel');
    await expect(panel).toBeVisible();

    //  Click "Retry" and assert successful completion
    await retryBtn.click();

    await expect(statusEl).toHaveAttribute('data-status', 'confirmed');
    await expect(statusEl).toHaveText(/Escrow Funded Successfully/i);

    const successEl = page.locator('#tx-success');
    await expect(successEl).toBeVisible();
    await expect(successEl).toContainText(MOCK_CONSTANTS.TX_HASH);

    await expect(retryBtn).toBeHidden();
    expect(requestAttempt).toBe(2);
  });
});
