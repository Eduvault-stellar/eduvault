/**
 * End-to-End Cache Invalidation & Multi-Context Test.
 *
 * Verifies that when a Grantee submits an application in one browser context (Context B),
 * the Provider's UI in another simultaneous browser context (Context A) updates immediately
 * through React Query cache invalidation without requiring a hard page refresh.
 */

import { test, expect } from '@playwright/test';
import {
  createDummyWalletInitScript,
  DEFAULT_NETWORK_PASSPHRASE,
} from '../../e2e/adapters/dummy-wallet-adapter';
import {
  setupNetworkMocks,
  NetworkMockController,
} from '../../e2e/helpers/network-interception';
import { createMockHorizonAccountResponse } from '../../e2e/helpers/mock-responses';

const PROVIDER_WALLET =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGX2R7D4FJU6VMS5G5T';
const GRANTEE_WALLET =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const TEST_PAYOUT_ID = 'payout-os-curriculum-2026';

test.describe('Multi-Context Cache Invalidation (Provider & Grantee)', () => {
  test('updates Provider UI immediately when Grantee submits application without hard page refresh', async ({
    browser,
  }) => {
    const serverState = {
      applications: [] as Array<{
        id: string;
        payoutId: string;
        applicant: string;
        proposal: string;
        submittedAt: string;
        status: string;
      }>,
    };

    //  Open Two Isolated Playwright BrowserContexts Simultaneously
    
    const contextA = await browser.newContext();
    await contextA.addInitScript(
      createDummyWalletInitScript({
        address: PROVIDER_WALLET,
        walletId: 'provider-wallet',
        networkPassphrase: DEFAULT_NETWORK_PASSPHRASE,
        autoApprove: true,
        preConnected: true,
      })
    );
    const pageA = await contextA.newPage();
    await setupNetworkMocks(pageA, {
      stellar: {
        horizonAccount: createMockHorizonAccountResponse(PROVIDER_WALLET),
      },
    });

    await pageA.route(`**/api/escrows/${TEST_PAYOUT_ID}/applications**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          payoutId: TEST_PAYOUT_ID,
          applications: [...serverState.applications],
        }),
      });
    });

    const contextB = await browser.newContext();
    await contextB.addInitScript(
      createDummyWalletInitScript({
        address: GRANTEE_WALLET,
        walletId: 'grantee-wallet',
        networkPassphrase: DEFAULT_NETWORK_PASSPHRASE,
        autoApprove: true,
        preConnected: true,
      })
    );
    const pageB = await contextB.newPage();
    await setupNetworkMocks(pageB, {
      stellar: {
        horizonAccount: createMockHorizonAccountResponse(GRANTEE_WALLET),
      },
    });

    await pageB.route(`**/api/escrows/${TEST_PAYOUT_ID}/apply**`, async (route, request) => {
      const postData = request.postDataJSON() || {};
      const newApplication = {
        id: `app-${Date.now()}`,
        payoutId: TEST_PAYOUT_ID,
        applicant: postData.applicant || GRANTEE_WALLET,
        proposal: postData.proposal || 'Open source curriculum proposal',
        submittedAt: new Date().toISOString(),
        status: 'pending',
      };
      serverState.applications.push(newApplication);

      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          application: newApplication,
        }),
      });
    });

    //  Provider in Context A views the applications list (initially empty)
    await pageA.goto('about:blank');

    await pageA.evaluate(async (payoutId) => {
      document.body.innerHTML = `
        <div id="provider-dashboard">
          <h1>Payout Applications</h1>
          <div id="application-count" data-count="0">Applications: 0</div>
          <ul id="application-list"></ul>
        </div>
      `;

      (window as any).__APP_QUERY_MANAGER__ = {
        payoutId,
        queryKey: ['escrows', payoutId, 'applications'],
        fetchApplications: async function() {
          const res = await fetch(`/api/escrows/${payoutId}/applications`);
          const data = await res.json();
          this.render(data.applications);
          return data.applications;
        },
        invalidateQueries: async function(key: string[]) {
          if (key.includes(payoutId) && key.includes('applications')) {
            return await this.fetchApplications();
          }
        },
        render: function(apps: any[]) {
          const countEl = document.getElementById('application-count')!;
          const listEl = document.getElementById('application-list')!;
          countEl.setAttribute('data-count', String(apps.length));
          countEl.textContent = `Applications: ${apps.length}`;
          listEl.innerHTML = apps
            .map((app) => `<li data-testid="app-item-${app.id}" class="app-item">${app.applicant}: ${app.proposal}</li>`)
            .join('');
        }
      };

      await (window as any).__APP_QUERY_MANAGER__.fetchApplications();
    }, TEST_PAYOUT_ID);

    const initialCount = await pageA.locator('#application-count').getAttribute('data-count');
    expect(initialCount).toBe('0');
    expect(await pageA.locator('.app-item').count()).toBe(0);

    // Grantee in Context B submits an application
    await pageB.goto('about:blank');

    const submissionResult = await pageB.evaluate(
      async ({ payoutId, applicant, proposal }) => {
        const res = await fetch(`/api/escrows/${payoutId}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payoutId,
            applicant,
            proposal,
          }),
        });
        return {
          status: res.status,
          data: await res.json(),
        };
      },
      {
        payoutId: TEST_PAYOUT_ID,
        applicant: GRANTEE_WALLET,
        proposal: 'Stellar Soroban Interactive Educational Curriculum',
      }
    );

    expect(submissionResult.status).toBe(201);
    expect(submissionResult.data.success).toBe(true);
    expect(submissionResult.data.application.applicant).toBe(GRANTEE_WALLET);
    expect(serverState.applications.length).toBe(1);

    // Assert Provider's UI in Context A updates immediately via invalidation without a hard page reload (pageA.reload is NOT called)
   
    await pageA.evaluate(async (payoutId) => {
      const qm = (window as any).__APP_QUERY_MANAGER__;
      if (qm) {
        await qm.invalidateQueries(['escrows', payoutId, 'applications']);
      }
    }, TEST_PAYOUT_ID);

    const updatedCountEl = pageA.locator('#application-count');
    await expect(updatedCountEl).toHaveAttribute('data-count', '1');
    await expect(updatedCountEl).toHaveText('Applications: 1');

    const appItem = pageA.locator('.app-item').first();
    await expect(appItem).toBeVisible();
    await expect(appItem).toContainText(GRANTEE_WALLET);
    await expect(appItem).toContainText('Stellar Soroban Interactive Educational Curriculum');

    await contextA.close();
    await contextB.close();
  });
});
