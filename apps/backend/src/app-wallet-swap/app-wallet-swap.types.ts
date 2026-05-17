export const APP_WALLET_SWAP_CHAIN = 'ARC-TESTNET' as const;
export const APP_WALLET_SWAP_MODE = 'treasury-mediated' as const;

export type AppWalletSwapChain = typeof APP_WALLET_SWAP_CHAIN;
export type AppWalletSwapMode = typeof APP_WALLET_SWAP_MODE;
export type AppWalletSwapToken = 'USDC' | 'EURC';

export type AppWalletSwapOperationStatus =
  | 'quoted'
  | 'awaiting_user_deposit'
  | 'deposit_submitted'
  | 'deposit_confirmed'
  | 'treasury_swap_pending'
  | 'treasury_swap_submitted'
  | 'treasury_swap_confirmed'
  | 'payout_pending'
  | 'payout_submitted'
  | 'payout_confirmed'
  | 'completed'
  | 'execution_failed';

export const APP_WALLET_SWAP_ERROR_CODES = {
  INVALID_REQUEST: 'APP_WALLET_SWAP_INVALID_REQUEST',
  TREASURY_NOT_CONFIGURED: 'APP_WALLET_SWAP_TREASURY_NOT_CONFIGURED',
  UNSUPPORTED_CHAIN: 'APP_WALLET_SWAP_UNSUPPORTED_CHAIN',
  EXECUTION_DISABLED: 'APP_WALLET_TREASURY_SWAP_EXECUTION_DISABLED',
  EXECUTION_FAILED: 'APP_WALLET_TREASURY_SWAP_EXECUTION_FAILED',
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
  circleWalletId?: string;
  depositTxHash?: string;
  circleTransactionId?: string;
  circleReferenceId?: string;
  depositSubmittedAt?: string;
  depositConfirmedAt?: string;
  depositConfirmedAmount?: string;
  depositConfirmationError?: string;
  treasurySwapId?: string;
  treasurySwapQuoteId?: string;
  treasurySwapTxHash?: string;
  treasurySwapSubmittedAt?: string;
  treasurySwapConfirmedAt?: string;
  treasurySwapExpectedOutput?: unknown;
  treasurySwapActualOutput?: string;
  rawTreasurySwap?: unknown;
  payoutTxHash?: string;
  payoutAmount?: string;
  payoutSubmittedAt?: string;
  payoutConfirmedAt?: string;
  rawPayout?: unknown;
  completedAt?: string;
  executionError?: string;
  createdAt: string;
  updatedAt: string;
  executionEnabled: boolean;
}

export interface AppWalletSwapDepositRequest {
  depositTxHash?: string;
  circleWalletId?: string;
  circleTransactionId?: string;
  circleReferenceId?: string;
}

export interface AppWalletSwapDepositTxHashRequest {
  depositTxHash: string;
}

export interface AppWalletSwapDepositVerificationRequest {
  amountIn: string;
  depositTxHash: string;
  tokenIn: AppWalletSwapToken;
  treasuryDepositAddress: string;
  userWalletAddress: string;
}

export interface AppWalletSwapDepositVerificationResult {
  confirmed: boolean;
  confirmedAmount?: string;
  error?: string;
}

export interface AppWalletSwapTreasurySwapVerificationRequest {
  tokenOut: AppWalletSwapToken;
  txHash: string;
  treasuryAddress: string;
  minimumOutput?: string;
}

export interface AppWalletSwapTreasurySwapVerificationResult {
  confirmed: boolean;
  actualOutput?: string;
  error?: string;
}

export interface AppWalletSwapPayoutVerificationRequest {
  tokenOut: AppWalletSwapToken;
  txHash: string;
  treasuryAddress: string;
  userWalletAddress: string;
  payoutAmount: string;
}

export interface AppWalletSwapPayoutVerificationResult {
  confirmed: boolean;
  error?: string;
}
