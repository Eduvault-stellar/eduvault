/**
 * Playwright Network Interception Utilities for Trustless Work API & Stellar Network.
 *
 * Provides granular route mocking for:
 * - Trustless Work escrow and milestone API calls (glob: trustless-work-api)
 * - Stellar Soroban JSON-RPC calls (sendTransaction, getTransaction, simulateTransaction, etc.)
 * - Stellar Horizon REST API calls (/accounts, /transactions)
 */

import type { Page, BrowserContext, Route, Request } from '@playwright/test';
import {
  MOCK_CONSTANTS,
  createMockFundingSuccessResponse,
  createMockFundingDelayedResponse,
  createMockFundingSignatureRejectedResponse,
  createMockSendTxSuccessResponse,
  createMockGetTxSuccessResponse,
  createMockGetTxPendingResponse,
  createMockSendTxRejectedResponse,
  createMockGetTxFailedResponse,
  createMockHorizonAccountResponse,
  EscrowFundingSuccessResponse,
  EscrowFundingPendingResponse,
  EscrowSignatureRejectedResponse,
  StellarRpcSendSuccessResponse,
  StellarRpcGetTxSuccessResponse,
  StellarRpcSendTxErrorResponse,
  HorizonAccountResponse,
} from './mock-responses';

export type FundingScenario = 'success' | 'delayed' | 'rejected' | 'custom';
export type StellarRpcScenario = 'success' | 'delayed' | 'rejected' | 'failed' | 'custom';

export interface TrustlessWorkInterceptorOptions {
  scenario?: FundingScenario;
  customFundingResponse?: EscrowFundingSuccessResponse | EscrowFundingPendingResponse | EscrowSignatureRejectedResponse | any;
  customEscrowStatus?: any;
  delayMs?: number;
}

export interface StellarNetworkInterceptorOptions {
  rpcScenario?: StellarRpcScenario;
  delayPollAttempts?: number; // Number of getTransaction polls before returning SUCCESS
  customSendTxResponse?: StellarRpcSendSuccessResponse | StellarRpcSendTxErrorResponse | any;
  customGetTxResponse?: StellarRpcGetTxSuccessResponse | any;
  horizonAccount?: HorizonAccountResponse;
  rpcDelayMs?: number;
}

export interface CombinedNetworkMockOptions {
  trustlessWork?: TrustlessWorkInterceptorOptions;
  stellar?: StellarNetworkInterceptorOptions;
}

export interface NetworkMockController {
  setFundingScenario(scenario: FundingScenario, customResponse?: any): void;
  setStellarRpcScenario(scenario: StellarRpcScenario, customResponse?: any): void;
  setPollAttemptsBeforeSuccess(count: number): void;
  getInterceptedRequests(): Array<{ url: string; method: string; postData: any; timestamp: number }>;
  clearInterceptedRequests(): void;
}


export async function interceptTrustlessWorkApi(
  target: Page | BrowserContext,
  options: TrustlessWorkInterceptorOptions = {}
): Promise<{ updateScenario: (scenario: FundingScenario, custom?: any) => void }> {
  let currentScenario: FundingScenario = options.scenario || 'success';
  let customResponse = options.customFundingResponse;

  const handler = async (route: Route, request: Request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postDataJSON() || {};

    if (options.delayMs && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }

    if (url.includes('/fund') && method === 'POST') {
      if (currentScenario === 'rejected') {
        const errorBody = customResponse || createMockFundingSignatureRejectedResponse();
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify(errorBody),
        });
      }

      if (currentScenario === 'delayed') {
        const delayedBody = customResponse || createMockFundingDelayedResponse({
          amount: postData.amount,
          escrowId: postData.escrowId,
        });
        return route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify(delayedBody),
        });
      }

      const successBody = customResponse || createMockFundingSuccessResponse({
        amount: postData.amount,
        escrowId: postData.escrowId,
        asset: postData.asset,
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(successBody),
      });
    }

    if ((url.includes('/escrow') || url.includes('/escrows')) && method === 'GET') {
      const escrowData = options.customEscrowStatus || {
        id: MOCK_CONSTANTS.ESCROW_ID,
        status: currentScenario === 'delayed' ? 'pending' : 'funded',
        balance: '10000000',
        asset: 'USDC',
        engager: MOCK_CONSTANTS.BUYER_ADDRESS,
        recipient: MOCK_CONSTANTS.SELLER_ADDRESS,
        updatedAt: new Date().toISOString(),
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(escrowData),
      });
    }

    if (url.includes('/milestone') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          status: 'approved',
          milestoneId: postData.milestoneId || '1',
          approvedAt: new Date().toISOString(),
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: 'Mock Trustless Work response',
        scenario: currentScenario,
      }),
    });
  };

  await target.route('**/trustless-work-api/**', handler);
  await target.route('**/api/trustless-work/**', handler);
  await target.route('*trustless-work-api*', handler);

  return {
    updateScenario: (scenario: FundingScenario, custom?: any) => {
      currentScenario = scenario;
      if (custom !== undefined) {
        customResponse = custom;
      }
    },
  };
}


export async function interceptStellarNetwork(
  target: Page | BrowserContext,
  options: StellarNetworkInterceptorOptions = {}
): Promise<{
  updateScenario: (scenario: StellarRpcScenario, custom?: any) => void;
  setPollAttempts: (attempts: number) => void;
}> {
  let currentRpcScenario: StellarRpcScenario = options.rpcScenario || 'success';
  let pollAttemptsBeforeSuccess = options.delayPollAttempts ?? 0;
  let customSendResponse = options.customSendTxResponse;
  let customGetResponse = options.customGetTxResponse;

  let pollCount = 0;

  const rpcHandler = async (route: Route, request: Request) => {
    if (options.rpcDelayMs && options.rpcDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.rpcDelayMs));
    }

    const postData = request.postDataJSON();
    if (!postData || typeof postData !== 'object') {
      return route.continue();
    }

    const { method, id = 1 } = postData;

    if (method === 'sendTransaction') {
      if (currentRpcScenario === 'rejected') {
        const errorResponse =
          customSendResponse || createMockSendTxRejectedResponse(id, 'User rejected signature');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(errorResponse),
        });
      }

      const successResponse = customSendResponse || createMockSendTxSuccessResponse(MOCK_CONSTANTS.TX_HASH, id);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(successResponse),
      });
    }

    if (method === 'getTransaction') {
      pollCount++;

      if (currentRpcScenario === 'failed') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(createMockGetTxFailedResponse(id)),
        });
      }

      if (currentRpcScenario === 'delayed' || pollCount <= pollAttemptsBeforeSuccess) {
        if (currentRpcScenario === 'delayed' && pollAttemptsBeforeSuccess === 0) {

          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(createMockGetTxPendingResponse(id)),
          });
        }

        if (pollCount <= pollAttemptsBeforeSuccess) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(createMockGetTxPendingResponse(id)),
          });
        }
      }

      const getTxSuccess = customGetResponse || createMockGetTxSuccessResponse(id);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(getTxSuccess),
      });
    }

    if (method === 'getLatestLedger') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            id: 'mock-ledger-id',
            sequence: MOCK_CONSTANTS.LEDGER_SEQUENCE,
            protocolVersion: 20,
          },
        }),
      });
    }

    if (method === 'simulateTransaction') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            minResourceFee: '100',
            latestLedger: MOCK_CONSTANTS.LEDGER_SEQUENCE,
            transactionData: 'AAAAAgAAAAA...',
          },
        }),
      });
    }

    if (method === 'getHealth') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { status: 'healthy' },
        }),
      });
    }

    return route.continue();
  };

  const horizonHandler = async (route: Route, request: Request) => {
    const url = request.url();


    if (url.includes('/accounts/')) {
      const parts = url.split('/accounts/');
      const address = parts[1]?.split('?')[0] || MOCK_CONSTANTS.BUYER_ADDRESS;
      const accountData = options.horizonAccount || createMockHorizonAccountResponse(address);

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(accountData),
      });
    }

    if (url.includes('/transactions/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: MOCK_CONSTANTS.TX_HASH,
          successful: true,
          hash: MOCK_CONSTANTS.TX_HASH,
          ledger: MOCK_CONSTANTS.LEDGER_SEQUENCE,
          created_at: new Date().toISOString(),
        }),
      });
    }

    return route.continue();
  };

  await target.route('https://soroban-testnet.stellar.org/**', rpcHandler);
  await target.route('https://soroban-rpc.stellar.org/**', rpcHandler);
  await target.route('**/soroban/rpc/**', rpcHandler);
  await target.route('**/soroban/rpc', rpcHandler);

  await target.route('https://horizon-testnet.stellar.org/**', horizonHandler);
  await target.route('https://horizon.stellar.org/**', horizonHandler);

  return {
    updateScenario: (scenario: StellarRpcScenario, custom?: any) => {
      currentRpcScenario = scenario;
      if (custom !== undefined) {
        if (scenario === 'rejected') customSendResponse = custom;
        else if (scenario === 'success') customGetResponse = custom;
      }
    },
    setPollAttempts: (attempts: number) => {
      pollAttemptsBeforeSuccess = attempts;
      pollCount = 0;
    },
  };
}


export async function setupNetworkMocks(
  target: Page | BrowserContext,
  options: CombinedNetworkMockOptions = {}
): Promise<NetworkMockController> {
  const interceptedRequests: Array<{
    url: string;
    method: string;
    postData: any;
    timestamp: number;
  }> = [];

  await target.route('**', async (route, request) => {
    const url = request.url();
    if (
      url.includes('trustless-work') ||
      url.includes('stellar.org') ||
      url.includes('/soroban')
    ) {
      interceptedRequests.push({
        url,
        method: request.method(),
        postData: request.postDataJSON() || null,
        timestamp: Date.now(),
      });
    }
    await route.fallback();
  });

  const trustlessController = await interceptTrustlessWorkApi(
    target,
    options.trustlessWork
  );
  const stellarController = await interceptStellarNetwork(
    target,
    options.stellar
  );

  return {
    setFundingScenario: (scenario: FundingScenario, custom?: any) => {
      trustlessController.updateScenario(scenario, custom);
    },
    setStellarRpcScenario: (scenario: StellarRpcScenario, custom?: any) => {
      stellarController.updateScenario(scenario, custom);
    },
    setPollAttemptsBeforeSuccess: (count: number) => {
      stellarController.setPollAttempts(count);
    },
    getInterceptedRequests: () => [...interceptedRequests],
    clearInterceptedRequests: () => {
      interceptedRequests.length = 0;
    },
  };
}
