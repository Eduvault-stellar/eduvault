import { test, expect } from '../fixtures';
import {
  MOCK_CONSTANTS,
  createMockFundingSuccessResponse,
  createMockFundingDelayedResponse,
  createMockFundingSignatureRejectedResponse,
  createMockSendTxSuccessResponse,
  createMockGetTxSuccessResponse,
  createMockGetTxPendingResponse,
  createMockSendTxRejectedResponse,
} from '../helpers/mock-responses';

test.describe('Dummy Wallet Adapter & Network Interception Fixtures', () => {
  test('injects deterministic dummy wallet adapter into browser context and auto-approves signatures', async ({
    page,
    dummyWallet,
  }) => {
    await page.goto('about:blank');

    const walletState = await page.evaluate(() => {
      const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
      return {
        address: w?.address,
        walletId: w?.walletId,
        autoApprove: w?.autoApprove,
        isConnected: w?.isConnected,
      };
    });

    expect(walletState.address).toBe(dummyWallet.address);
    expect(walletState.walletId).toBe(dummyWallet.walletId);
    expect(walletState.autoApprove).toBe(true);
    expect(walletState.isConnected).toBe(true);

    const signResult = await page.evaluate(async () => {
      const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
      return await w.signTransaction('AAAAAgAAAABTEST_TRANSACTION_XDR_DATA', {
        address: w.address,
      });
    });

    expect(signResult.signedTxXdr).toContain('MOCK_SIGNED_TX_');

    const authResult = await page.evaluate(async () => {
      const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
      return await w.signAuthEntry('AAAAAgAAAABTEST_AUTH_ENTRY_XDR_DATA', {
        address: w.address,
      });
    });

    expect(authResult.signedAuthEntry).toContain('MOCK_SIGNED_AUTH_');

    const signedHistory = await dummyWallet.getSignedTransactions();
    expect(signedHistory.length).toBe(1);
    expect(signedHistory[0].xdr).toBe('AAAAAgAAAABTEST_TRANSACTION_XDR_DATA');
  });

  test('intercepts Trustless Work API calls with successful funding mock response', async ({
    page,
    mockNetwork,
  }) => {
    await page.goto('about:blank');

    mockNetwork.setFundingScenario('success');

    const response = await page.evaluate(async () => {
      const res = await fetch('https://api.trustlesswork.com/trustless-work-api/escrow/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          escrowId: '0x4a7f8e9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
          amount: '10000000',
          asset: 'USDC',
        }),
      });
      return {
        status: res.status,
        data: await res.json(),
      };
    });

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.status).toBe('funded');
    expect(response.data.amount).toBe('10000000');
    expect(response.data.transactionHash).toBe(MOCK_CONSTANTS.TX_HASH);
  });

  test('intercepts Trustless Work API with delayed network confirmation and handles pending state', async ({
    page,
    mockNetwork,
  }) => {
    await page.goto('about:blank');

    mockNetwork.setFundingScenario('delayed');

    const response = await page.evaluate(async () => {
      const res = await fetch('https://api.trustlesswork.com/trustless-work-api/escrow/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          escrowId: '0x4a7f8e9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
          amount: '10000000',
        }),
      });
      return {
        status: res.status,
        data: await res.json(),
      };
    });

    expect(response.status).toBe(202);
    expect(response.data.success).toBe(true);
    expect(response.data.status).toBe('pending_confirmation');
    expect(response.data.retryAfterSeconds).toBe(2);
  });

  test('intercepts Trustless Work API with rejected signature mock response', async ({
    page,
    mockNetwork,
  }) => {
    await page.goto('about:blank');

    mockNetwork.setFundingScenario('rejected');

    const response = await page.evaluate(async () => {
      const res = await fetch('https://api.trustlesswork.com/trustless-work-api/escrow/fund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          escrowId: '0x4a7f8e9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
        }),
      });
      return {
        status: res.status,
        data: await res.json(),
      };
    });

    expect(response.status).toBe(400);
    expect(response.data.success).toBe(false);
    expect(response.data.code).toBe('SIGNATURE_REJECTED');
  });

  test('intercepts Stellar Soroban JSON-RPC sendTransaction and getTransaction successfully', async ({
    page,
  }) => {
    await page.goto('about:blank');

    const sendResult = await page.evaluate(async () => {
      const res = await fetch('https://soroban-testnet.stellar.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendTransaction',
          params: { transaction: 'AAAAAgAAAABMOCK_TX_XDR' },
        }),
      });
      return await res.json();
    });

    expect(sendResult.result.status).toBe('PENDING');
    expect(sendResult.result.hash).toBe(MOCK_CONSTANTS.TX_HASH);

    const getResult = await page.evaluate(async () => {
      const res = await fetch('https://soroban-testnet.stellar.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'getTransaction',
          params: { hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0' },
        }),
      });
      return await res.json();
    });

    expect(getResult.result.status).toBe('SUCCESS');
    expect(getResult.result.resultXdr).toBeTruthy();
  });

  test('intercepts Stellar Soroban JSON-RPC with delayed polling confirmation', async ({
    page,
    mockNetwork,
  }) => {
    await page.goto('about:blank');

    mockNetwork.setPollAttemptsBeforeSuccess(2);

    const poll1 = await page.evaluate(async () => {
      const res = await fetch('https://soroban-testnet.stellar.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: { hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0' },
        }),
      });
      return await res.json();
    });
    expect(poll1.result.status).toBe('NOT_FOUND');

    const poll2 = await page.evaluate(async () => {
      const res = await fetch('https://soroban-testnet.stellar.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'getTransaction',
          params: { hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0' },
        }),
      });
      return await res.json();
    });
    expect(poll2.result.status).toBe('NOT_FOUND');

    const poll3 = await page.evaluate(async () => {
      const res = await fetch('https://soroban-testnet.stellar.org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'getTransaction',
          params: { hash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0' },
        }),
      });
      return await res.json();
    });
    expect(poll3.result.status).toBe('SUCCESS');
  });

  test('handles wallet rejection mode and signature rejection error', async ({
    page,
    dummyWallet,
  }) => {
    await page.goto('about:blank');

    await dummyWallet.rejectNextSignature('Transaction cancelled before wallet signing');

    const result = await page.evaluate(async () => {
      const w = (window as any).__EDUVAULT_DUMMY_WALLET__;
      try {
        await w.signTransaction('AAAAAgAAAABTEST_TX', { address: w.address });
        return { success: true };
      } catch (err: any) {
        return {
          success: false,
          message: err.message,
          code: err.code,
          dismissed: err.dismissed,
        };
      }
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Transaction cancelled');
    expect(result.dismissed).toBe(true);
  });
});
