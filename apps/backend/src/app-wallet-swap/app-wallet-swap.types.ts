export const APP_WALLET_SWAP_CHAIN = 'ARC-TESTNET' as const;
export const APP_WALLET_SWAP_MODE = 'treasury-mediated' as const;

export type AppWalletSwapChain = typeof APP_WALLET_SWAP_CHAIN;
export type AppWalletSwapMode = typeof APP_WALLET_SWAP_MODE;
export type AppWalletSwapToken = 'USDC' | 'EURC';
export type AppWalletSwapProvider = 'swapkit' | 'stablefx';
export const APP_WALLET_SWAP_ROUTING_THRESHOLD_BASE_UNITS = 10_000_000n;

export function resolveAppWalletSwapProvider(
  amountInBaseUnits: string,
): AppWalletSwapProvider {
  if (!/^\d+$/.test(amountInBaseUnits)) {
    throw new Error('App Wallet amount must be an integer base-unit string.');
  }

  return BigInt(amountInBaseUnits) < APP_WALLET_SWAP_ROUTING_THRESHOLD_BASE_UNITS
    ? 'swapkit'
    : 'stablefx';
}

export type AppWalletSwapOperationStatus =
  | 'quoted'
  | 'awaiting_user_deposit'
  | 'deposit_submitted'
  | 'deposit_confirmed'
  | 'stablefx_quote_requested'
  | 'stablefx_trade_created'
  | 'stablefx_contract_ready'
  | 'stablefx_funded'
  | 'stablefx_settled_to_treasury'
  | 'treasury_swap_pending'
  | 'treasury_swap_submitted'
  | 'treasury_swap_confirmed'
  | 'payout_pending'
  | 'payout_submitted'
  | 'payout_confirmed'
  | 'completed'
  | 'execution_recovery_required'
  | 'refund_pending'
  | 'refund_submitted'
  | 'refunded'
  | 'execution_failed';

export const APP_WALLET_SWAP_ERROR_CODES = {
  INVALID_REQUEST: 'APP_WALLET_SWAP_INVALID_REQUEST',
  TREASURY_NOT_CONFIGURED: 'APP_WALLET_SWAP_TREASURY_NOT_CONFIGURED',
  UNSUPPORTED_CHAIN: 'APP_WALLET_SWAP_UNSUPPORTED_CHAIN',
  EXECUTION_DISABLED: 'APP_WALLET_TREASURY_SWAP_EXECUTION_DISABLED',
  EXECUTION_FAILED: 'APP_WALLET_TREASURY_SWAP_EXECUTION_FAILED',
  STABLEFX_APP_WALLET_DEPOSIT_REQUIRED: 'STABLEFX_APP_WALLET_DEPOSIT_REQUIRED',
  STABLEFX_APP_WALLET_DEPOSIT_NOT_CONFIRMED:
    'STABLEFX_APP_WALLET_DEPOSIT_NOT_CONFIRMED',
  STABLEFX_TREASURY_EXECUTION_FAILED: 'STABLEFX_TREASURY_EXECUTION_FAILED',
  STABLEFX_TREASURY_PAYOUT_FAILED: 'STABLEFX_TREASURY_PAYOUT_FAILED',
  EXECUTION_TIMEOUT: 'APP_WALLET_SWAP_EXECUTION_TIMEOUT',
  REFUND_NOT_SAFE: 'APP_WALLET_SWAP_REFUND_NOT_SAFE',
  STABLEFX_MIN_AMOUNT: 'STABLEFX_MIN_AMOUNT',
  EXECUTION_PROVIDER_INVALID: 'APP_WALLET_SWAP_EXECUTION_PROVIDER_INVALID',
  // Circle answered that it cannot route this direction at this amount.
  // Direction- and amount-dependent, so it is never a permanent pair block.
  SWAPKIT_ROUTE_UNAVAILABLE: 'SWAPKIT_ROUTE_UNAVAILABLE',
  // A SwapKit quote returned without a usable slippage-protected floor.
  // Fails closed at quote time, before any operation exists.
  SWAPKIT_QUOTE_MINIMUM_OUTPUT_INVALID:
    'SWAPKIT_QUOTE_MINIMUM_OUTPUT_INVALID',
  // No positive minimum output could be derived for on-chain verification.
  // Fails closed before financial execution is confirmed.
  SWAPKIT_MINIMUM_OUTPUT_UNVERIFIABLE: 'SWAPKIT_MINIMUM_OUTPUT_UNVERIFIABLE',
  SWAPKIT_USER_CONTROLLED_UNAVAILABLE:
    'APP_WALLET_SWAPKIT_USER_CONTROLLED_UNAVAILABLE',
} as const;

export interface AppWalletSwapQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fromAddress: string;
  chain: string;
  provider?: AppWalletSwapProvider;
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
  provider: AppWalletSwapProvider;
  quoteId?: unknown;
  rawQuote?: unknown;
}

export interface AppWalletSwapOperationRequest extends AppWalletSwapQuoteRequest {
  quoteId?: string;
}

export interface AppWalletSwapOperationResponse extends Omit<
  AppWalletSwapQuoteResponse,
  'status' | 'provider'
> {
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
  stablefxFundingRequestedAt?: string;
  stablefxFundedAt?: string;
  payoutTxHash?: string;
  payoutAmount?: string;
  payoutSubmittedAt?: string;
  payoutConfirmedAt?: string;
  rawPayout?: unknown;
  refundTransactionId?: string;
  refundTxHash?: string;
  refundAmount?: string;
  refundSubmittedAt?: string;
  refundConfirmedAt?: string;
  rawRefund?: unknown;
  completedAt?: string;
  executionError?: string;
  createdAt: string;
  updatedAt: string;
  executionEnabled: boolean;
  provider?: AppWalletSwapProvider;
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
  /**
   * Slippage-protected floor in base units. Required: a treasury swap must
   * never be confirmed against an implicit zero minimum.
   */
  minimumOutput: string;
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
