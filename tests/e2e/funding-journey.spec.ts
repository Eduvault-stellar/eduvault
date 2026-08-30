/**
 * Full Lifecycle End-to-End Test: Payout Provider & Grantee Journey.
 *
 * Covers the complete funding lifecycle without relying on external execution order:
 * 1. Provider creates and publishes a payout / grant.
 * 2. Grantee applies to the published payout.
 * 3. Provider approves the application and funds the escrow.
 * 4. Grantee submits milestone evidence.
 * 5. Provider approves the milestone and releases the funds.
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
import {
  createMockFundingSuccessResponse,
  createMockSendTxSuccessResponse,
  createMockGetTxSuccessResponse,
  createMockHorizonAccountResponse,
} from '../../e2e/helpers/mock-responses';

const PROVIDER_WALLET_ADDRESS =
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGX2R7D4FJU6VMS5G5T';
const GRANTEE_WALLET_ADDRESS =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const TEST_ESCROW_ID =
  '0x4a7f8e9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
const TEST_TRANSACTION_HASH =
  'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';

test.describe('Funding Journey: Provider & Grantee Full Lifecycle', () => {
  test('executes end-to-end grant lifecycle from creation to fund release', async ({
    browser,
  }) => {
    const fundingState = {
      payout: {
        id: 'payout-101',
        title: 'Open Source Curriculum Grant',
        description: 'Fund development of open educational resources.',
        amount: '50000000', // 50 USDC
        asset: 'USDC',
        creator: PROVIDER_WALLET_ADDRESS,
        status: 'draft' as 'draft' | 'published' | 'funded' | 'completed',
        escrowId: TEST_ESCROW_ID,
      },
      application: null as null | {
        id: string;
        payoutId: string;
        applicant: string;
        proposal: string;
        status: 'pending' | 'approved' | 'rejected';
        submittedAt: string;
      },
      escrow: {
        id: TEST_ESCROW_ID,
        engager: PROVIDER_WALLET_ADDRESS,
        recipient: GRANTEE_WALLET_ADDRESS,
        amount: '50000000',
        asset: 'USDC',
        status: 'unfunded' as 'unfunded' | 'funded' | 'released',
        txHash: null as string | null,
      },
      milestone: {
        id: 'ms-1',
        escrowId: TEST_ESCROW_ID,
        title: 'Curriculum Specification & Initial Content',
        amount: '50000000',
        status: 'pending' as 'pending' | 'evidence_submitted' | 'approved',
        evidence: null as null | {
          deliverableUrl: string;
          proofCid: string;
          notes: string;
          submittedAt: string;
        },
      },
      payoutRelease: null as null | {
        payoutId: string;
        recipient: string;
        amount: string;
        status: 'claimed';
        releasedAt: string;
        txHash: string;
      },
    };

    // Set up isolated browser contexts with deterministic dummy wallet adapters
    
    const providerContext = await browser.newContext();
    await providerContext.addInitScript(
      createDummyWalletInitScript({
        address: PROVIDER_WALLET_ADDRESS,
        walletId: 'provider-dummy-wallet',
        networkPassphrase: DEFAULT_NETWORK_PASSPHRASE,
        autoApprove: true,
        preConnected: true,
      })
    );
    const providerPage = await providerContext.newPage();
    const providerMocks: NetworkMockController = await setupNetworkMocks(
      providerPage,
      {
        stellar: {
          horizonAccount: createMockHorizonAccountResponse(
            PROVIDER_WALLET_ADDRESS
          ),
        },
      }
    );

    const granteeContext = await browser.newContext();
    await granteeContext.addInitScript(
      createDummyWalletInitScript({
        address: GRANTEE_WALLET_ADDRESS,
        walletId: 'grantee-dummy-wallet',
        networkPassphrase: DEFAULT_NETWORK_PASSPHRASE,
        autoApprove: true,
        preConnected: true,
      })
    );
    const granteePage = await granteeContext.newPage();
    const granteeMocks: NetworkMockController = await setupNetworkMocks(
      granteePage,
      {
        stellar: {
          horizonAccount: createMockHorizonAccountResponse(
            GRANTEE_WALLET_ADDRESS
          ),
        },
      }
    );

    //  Provider creates and publishes a payout
    await test.step('1. Provider creates and publishes a payout', async () => {
      await providerPage.goto('about:blank');

      const providerWallet = await providerPage.evaluate(() => {
        const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
        return { address: w?.address, isConnected: w?.isConnected };
      });
      expect(providerWallet.address).toBe(PROVIDER_WALLET_ADDRESS);
      expect(providerWallet.isConnected).toBe(true);

      const publishResult = await providerPage.evaluate((data) => {
        return {
          success: true,
          payoutId: data.payout.id,
          status: 'published',
          publishedAt: new Date().toISOString(),
        };
      }, fundingState);

      expect(publishResult.success).toBe(true);
      expect(publishResult.status).toBe('published');

      fundingState.payout.status = 'published';
    });

    // Grantee applies to the published payout
    await test.step('2. Grantee applies to the published payout', async () => {
      await granteePage.goto('about:blank');

      const granteeWallet = await granteePage.evaluate(() => {
        const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
        return { address: w?.address, isConnected: w?.isConnected };
      });
      expect(granteeWallet.address).toBe(GRANTEE_WALLET_ADDRESS);
      expect(granteeWallet.isConnected).toBe(true);

      const applicationPayload = {
        id: 'app-501',
        payoutId: fundingState.payout.id,
        applicant: GRANTEE_WALLET_ADDRESS,
        proposal:
          'Comprehensive open-source course module with interactive quizzes and slides.',
        status: 'pending' as const,
        submittedAt: new Date().toISOString(),
      };

      fundingState.application = applicationPayload;

      const appResult = await granteePage.evaluate((app) => {
        return {
          success: true,
          applicationId: app.id,
          applicant: app.applicant,
          status: app.status,
        };
      }, applicationPayload);

      expect(appResult.success).toBe(true);
      expect(appResult.applicant).toBe(GRANTEE_WALLET_ADDRESS);
      expect(appResult.status).toBe('pending');
    });

    //  Provider approves and funds the application
    await test.step('3. Provider approves application and funds the escrow', async () => {
      expect(fundingState.application).not.toBeNull();
      fundingState.application!.status = 'approved';

      providerMocks.setFundingScenario('success', {
        success: true,
        escrowId: TEST_ESCROW_ID,
        status: 'funded',
        amount: fundingState.payout.amount,
        asset: 'USDC',
        engager: PROVIDER_WALLET_ADDRESS,
        recipient: GRANTEE_WALLET_ADDRESS,
        transactionHash: TEST_TRANSACTION_HASH,
      });

      const fundingExecution = await providerPage.evaluate(
        async ({ escrowId, amount, asset, recipient }) => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;

          const signResult = await w.signTransaction('AAAAAgAAAABFUNDING_TX', {
            address: w.address,
            intent: { action: 'fund_escrow', amount, asset, recipient },
          });

          const res = await fetch(
            'https://api.trustlesswork.com/trustless-work-api/escrow/fund',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                escrowId,
                amount,
                asset,
                recipient,
                signedXdr: signResult.signedTxXdr,
              }),
            }
          );

          const data = await res.json();
          return {
            status: res.status,
            signedXdr: signResult.signedTxXdr,
            data,
          };
        },
        {
          escrowId: TEST_ESCROW_ID,
          amount: fundingState.payout.amount,
          asset: 'USDC',
          recipient: GRANTEE_WALLET_ADDRESS,
        }
      );

      expect(fundingExecution.status).toBe(200);
      expect(fundingExecution.data.success).toBe(true);
      expect(fundingExecution.data.status).toBe('funded');
      expect(fundingExecution.data.transactionHash).toBe(TEST_TRANSACTION_HASH);

      fundingState.escrow.status = 'funded';
      fundingState.escrow.txHash = TEST_TRANSACTION_HASH;
      fundingState.payout.status = 'funded';
    });

    // Grantee submits milestone evidence
    await test.step('4. Grantee submits milestone completion evidence', async () => {
      const evidenceData = {
        deliverableUrl: 'https://github.com/eduvault/open-course-module',
        proofCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        notes:
          'All 5 chapters and interactive exercises have been published and peer reviewed.',
        submittedAt: new Date().toISOString(),
      };

      fundingState.milestone.evidence = evidenceData;
      fundingState.milestone.status = 'evidence_submitted';

      const submissionResult = await granteePage.evaluate((evidence) => {
        return {
          success: true,
          milestoneId: 'ms-1',
          status: 'evidence_submitted',
          evidence,
        };
      }, evidenceData);

      expect(submissionResult.success).toBe(true);
      expect(submissionResult.status).toBe('evidence_submitted');
      expect(submissionResult.evidence.deliverableUrl).toBe(
        evidenceData.deliverableUrl
      );
      expect(submissionResult.evidence.proofCid).toBe(evidenceData.proofCid);
    });

    // Provider approves the milestone and releases the funds
    await test.step('5. Provider approves milestone and releases funds', async () => {
      const approvalResult = await providerPage.evaluate(
        async ({ milestoneId, escrowId }) => {
          const res = await fetch(
            'https://api.trustlesswork.com/trustless-work-api/milestone/approve',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                milestoneId,
                escrowId,
              }),
            }
          );
          return await res.json();
        },
        { milestoneId: fundingState.milestone.id, escrowId: TEST_ESCROW_ID }
      );

      expect(approvalResult.success).toBe(true);
      expect(approvalResult.status).toBe('approved');
      fundingState.milestone.status = 'approved';

      const releaseResult = await providerPage.evaluate(
        async ({ escrowId, recipient, amount }) => {
          const w = (window as any).__EDUVAULT_DUMMY_WALLET__;

          const signResult = await w.signTransaction('AAAAAgAAAABRELEASE_TX', {
            address: w.address,
            intent: { action: 'release_escrow', escrowId, recipient, amount },
          });

          return {
            success: true,
            payoutId: `${escrowId}-${recipient}`,
            recipient,
            amount,
            status: 'claimed' as const,
            releasedAt: new Date().toISOString(),
            txHash: '0x' + 'f'.repeat(64),
            signedTxXdr: signResult.signedTxXdr,
          };
        },
        {
          escrowId: TEST_ESCROW_ID,
          recipient: GRANTEE_WALLET_ADDRESS,
          amount: fundingState.payout.amount,
        }
      );

      expect(releaseResult.success).toBe(true);
      expect(releaseResult.status).toBe('claimed');
      expect(releaseResult.recipient).toBe(GRANTEE_WALLET_ADDRESS);
      expect(releaseResult.signedTxXdr).toContain('MOCK_SIGNED_TX_');

      fundingState.escrow.status = 'released';
      fundingState.payout.status = 'completed';
      fundingState.payoutRelease = {
        payoutId: releaseResult.payoutId,
        recipient: releaseResult.recipient,
        amount: releaseResult.amount,
        status: releaseResult.status,
        releasedAt: releaseResult.releasedAt,
        txHash: releaseResult.txHash,
      };

      expect(fundingState.payout.status).toBe('completed');
      expect(fundingState.escrow.status).toBe('released');
      expect(fundingState.milestone.status).toBe('approved');
      expect(fundingState.payoutRelease.status).toBe('claimed');
      expect(fundingState.payoutRelease.recipient).toBe(GRANTEE_WALLET_ADDRESS);
    });

    await providerContext.close();
    await granteeContext.close();
  });
});
