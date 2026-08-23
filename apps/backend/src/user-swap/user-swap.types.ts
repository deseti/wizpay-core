export const USER_SWAP_ALLOWED_CHAIN = 'ARC-TESTNET' as const;
export const USER_SWAP_STABLEFX_QUOTE_PATH =
  '/v1/exchange/stablefx/quotes' as const;
export const USER_SWAP_STABLEFX_TRADES_PATH =
  '/v1/exchange/stablefx/trades' as const;
export const USER_SWAP_STABLEFX_FUNDING_PRESIGN_PATH =
  '/v1/exchange/stablefx/signatures/funding/presign' as const;
export const USER_SWAP_STABLEFX_FUND_PATH =
  '/v1/exchange/stablefx/fund' as const;

export const USER_SWAP_ERROR_CODES = {
  DISABLED: 'USER_SWAP_DISABLED',
  INVALID_REQUEST: 'USER_SWAP_INVALID_REQUEST',
  TESTNET_DISABLED: 'USER_SWAP_TESTNET_DISABLED',
  UNSUPPORTED_CHAIN: 'USER_SWAP_UNSUPPORTED_CHAIN',
  STABLEFX_API_KEY_MISSING: 'USER_SWAP_STABLEFX_API_KEY_MISSING',
  STABLEFX_AMOUNT_BELOW_MINIMUM: 'USER_SWAP_STABLEFX_AMOUNT_BELOW_MINIMUM',
  STABLEFX_AUTH_BLOCKED: 'USER_SWAP_STABLEFX_AUTH_BLOCKED',
  STABLEFX_API_FAILED: 'USER_SWAP_STABLEFX_API_FAILED',
  STABLEFX_ADDRESS_MISMATCH: 'USER_SWAP_STABLEFX_ADDRESS_MISMATCH',
  STABLEFX_CONTRACT_TRADE_ID_MISSING:
    'USER_SWAP_STABLEFX_CONTRACT_TRADE_ID_MISSING',
  STABLEFX_EXECUTION_DISABLED: 'USER_SWAP_STABLEFX_EXECUTION_DISABLED',
  STABLEFX_QUOTE_EXPIRED: 'USER_SWAP_STABLEFX_QUOTE_EXPIRED',
  STABLEFX_UNEXPECTED_RESPONSE: 'USER_SWAP_STABLEFX_UNEXPECTED_RESPONSE',
  STABLEFX_UNSUPPORTED_PAIR: 'USER_SWAP_STABLEFX_UNSUPPORTED_PAIR',
  // XyloNet quote provider error codes.
  XYLONET_CONFIG_MISSING: 'USER_SWAP_XYLONET_CONFIG_MISSING',
  XYLONET_FEE_CONFIG_INVALID: 'USER_SWAP_XYLONET_FEE_CONFIG_INVALID',
  XYLONET_QUOTE_FAILED: 'USER_SWAP_XYLONET_QUOTE_FAILED',
  XYLONET_UNSUPPORTED_PAIR: 'USER_SWAP_XYLONET_UNSUPPORTED_PAIR',
} as const;

export type UserSwapChain = typeof USER_SWAP_ALLOWED_CHAIN;
export type UserSwapToken = 'USDC' | 'EURC';

export type UserSwapProvider = 'xylonet';

export interface UserSwapBaseRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fromAddress: string;
  toAddress?: string;
  chain: string;
}

export interface UserSwapQuoteRequest extends UserSwapBaseRequest {
  slippageBps?: number;
}

export interface UserSwapPrepareResponse {
  raw?: unknown;
  transaction: {
    to?: unknown;
    data?: unknown;
    raw: unknown;
  };
}

export interface UserSwapNormalizedQuote {
  tokenIn: UserSwapToken;
  tokenOut: UserSwapToken;
  amountIn: string;
  fromAddress: string;
  toAddress: string;
  chain: UserSwapChain;
  provider: UserSwapProvider;
  expectedOutput?: unknown;
  minimumOutput?: unknown;
  fees?: unknown;
  expiresAt?: unknown;
  quoteId?: unknown;
  routerAddress?: unknown;
  executorAddress?: unknown;
  feeAmount?: unknown;
  netAmountIn?: unknown;
  expectedAmountOut?: unknown;
  minimumAmountOut?: unknown;
  minAmountOut?: unknown;
  chainId?: unknown;
  tokenInAddress?: unknown;
  tokenOutAddress?: unknown;
  recipientAddress?: unknown;
  raw: unknown;
}
