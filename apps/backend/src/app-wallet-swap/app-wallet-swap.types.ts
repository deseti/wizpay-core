export const APP_WALLET_SWAP_CHAIN = 'ARC-TESTNET' as const;
export const APP_WALLET_SWAP_MODE = 'treasury-mediated' as const;

export type AppWalletSwapChain = typeof APP_WALLET_SWAP_CHAIN;
export type AppWalletSwapMode = typeof APP_WALLET_SWAP_MODE;
export type AppWalletSwapToken = 'USDC' | 'EURC';

export type AppWalletSwapOperationStatus =
  | 'quoted'
  | 'awaiting_user_deposit'
  | 'deposit_submitted';

export const APP_WALLET_SWAP_ERROR_CODES = {
  INVALID_REQUEST: 'APP_WALLET_SWAP_INVALID_REQUEST',
  TREASURY_NOT_CONFIGURED: 'APP_WALLET_SWAP_TREASURY_NOT_CONFIGURED',
  UNSUPPORTED_CHAIN: 'APP_WALLET_SWAP_UNSUPPORTED_CHAIN',
  EXECUTION_DISABLED: 'APP_WALLET_TREASURY_SWAP_EXECUTION_DISABLED',
} as const;

export interface AppWalletSwapQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fromAddress: string;
  chain: string;
}

export interface AppWalletSwapQuoteResponse {
  operationMode: AppWalletSwapMode;
  sourceChain: AppWalletSwapChain;
  tokenIn: AppWalletSwapToken;
  tokenOut: AppWalletSwapToken;
  amountIn: string;
  treasuryDepositAddress: string;
  expectedOutput: unknown;
  minimumOutput: unknown;
  expiresAt: string;
  status: 'quoted';
  quoteId?: unknown;
  rawQuote?: unknown;
}

export interface AppWalletSwapOperationRequest
  extends AppWalletSwapQuoteRequest {
  quoteId?: string;
}

export interface AppWalletSwapOperationResponse
  extends Omit<AppWalletSwapQuoteResponse, 'status'> {
  operationId: string;
  status: Exclude<AppWalletSwapOperationStatus, 'quoted'>;
  userWalletAddress: string;
  depositTxHash?: string;
  circleTransactionId?: string;
  circleReferenceId?: string;
  depositSubmittedAt?: string;
  createdAt: string;
  updatedAt: string;
  executionEnabled: boolean;
}

export interface AppWalletSwapDepositRequest {
  depositTxHash?: string;
  circleTransactionId?: string;
  circleReferenceId?: string;
}
