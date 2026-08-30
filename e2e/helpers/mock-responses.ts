/**
 * Mock JSON Responses for E2E Testing.
 *
 * Provides typed, deterministic mock responses for:
 * 1. Successful funding (Trustless Work API, Stellar RPC, Horizon)
 * 2. Delayed network confirmations (RPC polling state machine, Trustless Work pending status)
 * 3. Rejected signatures (Wallet user rejection, RPC signature failure, API authorization errors)
 */

import {
  DEFAULT_TEST_WALLET_ADDRESS,
  DEFAULT_NETWORK_PASSPHRASE,
} from '../adapters/dummy-wallet-adapter';

export const MOCK_CONSTANTS = {
  ESCROW_ID: '0x4a7f8e9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
  TX_HASH: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
  CONTRACT_ID: 'CA3D5KRYMCMUZGAPOVOXZPOOWVECEF6VYDXQLYXAQFIOA6ZQ12345678',
  BUYER_ADDRESS: DEFAULT_TEST_WALLET_ADDRESS,
  SELLER_ADDRESS: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  LEDGER_SEQUENCE: 5849200,
};

// Successful Funding Mocks

export interface EscrowFundingSuccessResponse {
  success: boolean;
  escrowId: string;
  status: 'funded';
  amount: string;
  asset: string;
  engager: string;
  recipient: string;
  transactionHash: string;
  fundedAt: string;
  milestones: Array<{
    id: string;
    status: 'pending' | 'approved' | 'completed';
    amount: string;
    description: string;
  }>;
}

export function createMockFundingSuccessResponse(
  overrides: Partial<EscrowFundingSuccessResponse> = {}
): EscrowFundingSuccessResponse {
  return {
    success: true,
    escrowId: overrides.escrowId || MOCK_CONSTANTS.ESCROW_ID,
    status: 'funded',
    amount: overrides.amount || '10000000', // 10 USDC (7 decimals)
    asset: overrides.asset || 'USDC',
    engager: overrides.engager || MOCK_CONSTANTS.BUYER_ADDRESS,
    recipient: overrides.recipient || MOCK_CONSTANTS.SELLER_ADDRESS,
    transactionHash: overrides.transactionHash || MOCK_CONSTANTS.TX_HASH,
    fundedAt: overrides.fundedAt || new Date().toISOString(),
    milestones: overrides.milestones || [
      {
        id: '1',
        status: 'pending',
        amount: overrides.amount || '10000000',
        description: 'Material Access Grant',
      },
    ],
  };
}

export interface StellarRpcSendSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: {
    status: 'PENDING';
    hash: string;
    latestLedger: number;
    latestLedgerCloseTime: string;
  };
}

export function createMockSendTxSuccessResponse(
  hash: string = MOCK_CONSTANTS.TX_HASH,
  id: number = 1
): StellarRpcSendSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'PENDING',
      hash,
      latestLedger: MOCK_CONSTANTS.LEDGER_SEQUENCE,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000).toString(),
    },
  };
}

export interface StellarRpcGetTxSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: {
    status: 'SUCCESS';
    latestLedger: number;
    latestLedgerCloseTime: string;
    ledger: number;
    createdAt: string;
    applicationOrder: number;
    feeBump: boolean;
    envelopeXdr: string;
    resultXdr: string;
    resultMetaXdr: string;
  };
}

export function createMockGetTxSuccessResponse(
  id: number = 1,
  overrides: Partial<StellarRpcGetTxSuccessResponse['result']> = {}
): StellarRpcGetTxSuccessResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'SUCCESS',
      latestLedger: MOCK_CONSTANTS.LEDGER_SEQUENCE + 2,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000).toString(),
      ledger: MOCK_CONSTANTS.LEDGER_SEQUENCE + 1,
      createdAt: Math.floor(Date.now() / 1000).toString(),
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: 'AAAAAgAAAABMOCK_ENVELOPE_XDR',
      resultXdr: 'AAAAAwAAAAEMOCK_RESULT_XDR',
      resultMetaXdr: 'AAAAAQAAAABMOCK_RESULT_META_XDR',
      ...overrides,
    },
  };
}

export interface HorizonAccountResponse {
  id: string;
  account_id: string;
  sequence: string;
  balances: Array<{
    asset_type: string;
    balance: string;
    asset_code?: string;
    asset_issuer?: string;
    liquidity_pool_id?: string;
  }>;
}

export function createMockHorizonAccountResponse(
  address: string = MOCK_CONSTANTS.BUYER_ADDRESS,
  balances?: HorizonAccountResponse['balances']
): HorizonAccountResponse {
  return {
    id: address,
    account_id: address,
    sequence: '1234567890123',
    balances: balances || [
      {
        asset_type: 'native',
        balance: '150.0000000',
      },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: MOCK_CONSTANTS.USDC_ISSUER,
        balance: '500.0000000',
      },
    ],
  };
}

// Delayed Network Confirmation Mocks

export interface EscrowFundingPendingResponse {
  success: boolean;
  escrowId: string;
  status: 'pending_confirmation';
  message: string;
  retryAfterSeconds: number;
  transactionHash: string;
  amount?: string;
}

export function createMockFundingDelayedResponse(
  overrides: Partial<EscrowFundingPendingResponse> = {}
): EscrowFundingPendingResponse {
  return {
    success: true,
    escrowId: overrides.escrowId || MOCK_CONSTANTS.ESCROW_ID,
    status: 'pending_confirmation',
    message: 'Transaction submitted; waiting for network ledger confirmation',
    retryAfterSeconds: overrides.retryAfterSeconds ?? 2,
    transactionHash: overrides.transactionHash || MOCK_CONSTANTS.TX_HASH,
  };
}

export interface StellarRpcGetTxPendingResponse {
  jsonrpc: '2.0';
  id: number;
  result: {
    status: 'NOT_FOUND';
    latestLedger: number;
    latestLedgerCloseTime: string;
  };
}

export function createMockGetTxPendingResponse(id: number = 1): StellarRpcGetTxPendingResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'NOT_FOUND',
      latestLedger: MOCK_CONSTANTS.LEDGER_SEQUENCE,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000).toString(),
    },
  };
}

// Rejected Signature Mocks

export interface EscrowSignatureRejectedResponse {
  success: boolean;
  error: string;
  code: 'SIGNATURE_REJECTED' | 'UNAUTHORIZED';
  statusCode: number;
  details: {
    reason: string;
  };
}

export function createMockFundingSignatureRejectedResponse(
  reason: string = 'User declined signature request'
): EscrowSignatureRejectedResponse {
  return {
    success: false,
    error: 'Transaction signature was rejected',
    code: 'SIGNATURE_REJECTED',
    statusCode: 400,
    details: {
      reason,
    },
  };
}

export interface StellarRpcSendTxErrorResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    status: 'ERROR';
    errorResultXdr: string;
    diagnosticEventsXdr: string[];
  };
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export function createMockSendTxRejectedResponse(
  id: number = 1,
  errorMessage: string = 'Transaction rejected: bad auth or signature rejected by user'
): StellarRpcSendTxErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'ERROR',
      errorResultXdr: 'AAAAAP////8AAAAA_REJECTED_SIG_XDR',
      diagnosticEventsXdr: [],
    },
    error: {
      code: -32603,
      message: errorMessage,
    },
  };
}

export interface StellarRpcGetTxFailedResponse {
  jsonrpc: '2.0';
  id: number;
  result: {
    status: 'FAILED';
    latestLedger: number;
    latestLedgerCloseTime: string;
    resultXdr: string;
  };
}

export function createMockGetTxFailedResponse(
  id: number = 1,
  resultXdr: string = 'AAAAAP////8AAAAA_TX_FAILED_ON_CHAIN'
): StellarRpcGetTxFailedResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      status: 'FAILED',
      latestLedger: MOCK_CONSTANTS.LEDGER_SEQUENCE + 1,
      latestLedgerCloseTime: Math.floor(Date.now() / 1000).toString(),
      resultXdr,
    },
  };
}

//  Grouped Scenario Collections

export const mockResponses = {
  // Successful funding bundle
  successfulFunding: {
    trustlessWork: createMockFundingSuccessResponse(),
    sendTransaction: createMockSendTxSuccessResponse(),
    getTransaction: createMockGetTxSuccessResponse(),
    horizonAccount: createMockHorizonAccountResponse(),
  },

  // Delayed confirmation bundle
  delayedConfirmation: {
    trustlessWork: createMockFundingDelayedResponse(),
    getTransactionPending: createMockGetTxPendingResponse(),
    getTransactionSuccess: createMockGetTxSuccessResponse(),
  },

  // Rejected signatures bundle
  rejectedSignatures: {
    trustlessWork: createMockFundingSignatureRejectedResponse(),
    sendTransactionError: createMockSendTxRejectedResponse(),
    getTransactionFailed: createMockGetTxFailedResponse(),
  },
};
