import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_TEST_WALLET_ADDRESS,
  DEFAULT_TEST_WALLET_ID,
  DEFAULT_NETWORK_PASSPHRASE,
  SESSION_STORAGE_KEY,
  createDummyWalletInitScript,
} from '../../e2e/adapters/dummy-wallet-adapter';
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
  mockResponses,
} from '../../e2e/helpers/mock-responses';

describe('Dummy Wallet Adapter & Test Fixtures', () => {
  it('generates correct browser initialization script with defaults', () => {
    const script = createDummyWalletInitScript();
    expect(script).toContain(DEFAULT_TEST_WALLET_ADDRESS);
    expect(script).toContain(DEFAULT_TEST_WALLET_ID);
    expect(script).toContain(DEFAULT_NETWORK_PASSPHRASE);
    expect(script).toContain(SESSION_STORAGE_KEY);
    expect(script).toContain('window.__EDUVAULT_DUMMY_WALLET__');
    expect(script).toContain('window.freighterApi');
  });

  it('generates custom script when custom options are provided', () => {
    const customAddress = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    const script = createDummyWalletInitScript({
      address: customAddress,
      autoApprove: false,
      rejectionReason: 'Custom rejection message',
    });
    expect(script).toContain(customAddress);
    expect(script).toContain('autoApprove: false');
    expect(script).toContain('Custom rejection message');
  });

  it('executes injected dummy wallet methods and auto-approves signatures', async () => {
    const script = createDummyWalletInitScript();
    
    eval(script);

    const dummyWallet = window.__EDUVAULT_DUMMY_WALLET__;
    expect(dummyWallet).toBeDefined();
    expect(dummyWallet.address).toBe(DEFAULT_TEST_WALLET_ADDRESS);
    expect(dummyWallet.autoApprove).toBe(true);
    expect(dummyWallet.isConnected).toBe(true);

    const addrResult = await dummyWallet.getAddress();
    expect(addrResult.address).toBe(DEFAULT_TEST_WALLET_ADDRESS);

    const txResult = await dummyWallet.signTransaction('AAAAAgAAAABTEST_TX', {
      address: dummyWallet.address,
    });
    expect(txResult.signedTxXdr).toContain('MOCK_SIGNED_TX_');

    const authResult = await dummyWallet.signAuthEntry('AAAAAgAAAABTEST_AUTH', {
      address: dummyWallet.address,
    });
    expect(authResult.signedAuthEntry).toContain('MOCK_SIGNED_AUTH_');

    expect(dummyWallet.history.length).toBe(2);
    expect(dummyWallet.history[0].type).toBe('signTransaction');
    expect(dummyWallet.history[1].type).toBe('signAuthEntry');

    dummyWallet.setAutoApprove(false);
    dummyWallet.setRejectionReason('User cancelled');
    await expect(
      dummyWallet.signTransaction('AAAAAgAAAABTEST_TX', {})
    ).rejects.toThrow('User cancelled');
  });
});

describe('Mock JSON Responses', () => {
  describe('Successful Funding', () => {
    it('creates valid Trustless Work funding success payload', () => {
      const resp = createMockFundingSuccessResponse();
      expect(resp.success).toBe(true);
      expect(resp.status).toBe('funded');
      expect(resp.escrowId).toBe(MOCK_CONSTANTS.ESCROW_ID);
      expect(resp.transactionHash).toBe(MOCK_CONSTANTS.TX_HASH);
      expect(resp.amount).toBe('10000000');
      expect(resp.milestones.length).toBeGreaterThan(0);
    });

    it('creates valid Stellar RPC sendTransaction success payload', () => {
      const resp = createMockSendTxSuccessResponse();
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.result.status).toBe('PENDING');
      expect(resp.result.hash).toBe(MOCK_CONSTANTS.TX_HASH);
    });

    it('creates valid Stellar RPC getTransaction success payload', () => {
      const resp = createMockGetTxSuccessResponse();
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.result.status).toBe('SUCCESS');
      expect(resp.result.resultXdr).toBeTruthy();
    });

    it('creates valid Horizon account balance payload', () => {
      const resp = createMockHorizonAccountResponse();
      expect(resp.account_id).toBe(MOCK_CONSTANTS.BUYER_ADDRESS);
      expect(resp.balances.length).toBe(2);
      expect(resp.balances[0].asset_type).toBe('native');
      expect(resp.balances[1].asset_code).toBe('USDC');
    });
  });

  describe('Delayed Network Confirmations', () => {
    it('creates valid Trustless Work delayed confirmation payload', () => {
      const resp = createMockFundingDelayedResponse();
      expect(resp.success).toBe(true);
      expect(resp.status).toBe('pending_confirmation');
      expect(resp.retryAfterSeconds).toBe(2);
      expect(resp.transactionHash).toBe(MOCK_CONSTANTS.TX_HASH);
    });

    it('creates valid Stellar RPC pending poll response', () => {
      const resp = createMockGetTxPendingResponse();
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.result.status).toBe('NOT_FOUND');
    });
  });

  describe('Rejected Signatures', () => {
    it('creates valid Trustless Work signature rejected payload', () => {
      const resp = createMockFundingSignatureRejectedResponse();
      expect(resp.success).toBe(false);
      expect(resp.code).toBe('SIGNATURE_REJECTED');
      expect(resp.statusCode).toBe(400);
    });

    it('creates valid Stellar RPC sendTransaction rejected payload', () => {
      const resp = createMockSendTxRejectedResponse();
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.result?.status).toBe('ERROR');
      expect(resp.result?.errorResultXdr).toBeTruthy();
    });

    it('creates valid Stellar RPC getTransaction failed payload', () => {
      const resp = createMockGetTxFailedResponse();
      expect(resp.jsonrpc).toBe('2.0');
      expect(resp.result.status).toBe('FAILED');
      expect(resp.result.resultXdr).toBeTruthy();
    });
  });
});
