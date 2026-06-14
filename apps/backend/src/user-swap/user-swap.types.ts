export const USER_SWAP_ALLOWED_CHAIN = 'ARC-TESTNET' as const;
export const USER_SWAP_API_BASE_URL = 'https://api.circle.com' as const;

export const USER_SWAP_STABLEFX_QUOTE_URL =
  'https://api.circle.com/v1/exchange/stablefx/quotes' as const;
export const USER_SWAP_STABLEFX_QUOTE_PATH =
  '/v1/exchange/stablefx/quotes' as const;
export const USER_SWAP_STABLEFX_TRADES_PATH =
  '/v1/exchange/stablefx/trades' as const;
export const USER_SWAP_STABLEFX_FUNDING_PRESIGN_PATH =
  '/v1/exchange/stablefx/signatures/funding/presign' as const;
export const USER_SWAP_STABLEFX_FUND_PATH =
  '/v1/exchange/stablefx/fund' as const;

export const USER_SWAP_ERROR_CODES = {
  CIRCLE_STABLECOIN_API_FAILED: 'CIRCLE_STABLECOIN_API_FAILED',
  CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE:
    'CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE',
  DISABLED: 'USER_SWAP_DISABLED',
  INVALID_REQUEST: 'USER_SWAP_INVALID_REQUEST',
  KIT_KEY_MISSING: 'USER_SWAP_KIT_KEY_MISSING',
  PROVIDER_UNSUPPORTED: 'USER_SWAP_PROVIDER_UNSUPPORTED',
  TESTNET_DISABLED: 'USER_SWAP_TESTNET_DISABLED',
  UNSUPPORTED_CHAIN: 'USER_SWAP_UNSUPPORTED_CHAIN',
  // StableFX quote provider error codes.
  STABLEFX_API_KEY_MISSING: 'USER_SWAP_STABLEFX_API_KEY_MISSING',
  STABLEFX_AMOUNT_BELOW_MINIMUM: 'USER_SWAP_STABLEFX_AMOUNT_BELOW_MINIMUM',
  STABLEFX_AUTH_BLOCKED: 'USER_SWAP_STABLEFX_AUTH_BLOCKED',
  STABLEFX_API_FAILED: 'USER_SWAP_STABLEFX_API_FAILED',
  STABLEFX_ADDRESS_MISMATCH: 'USER_SWAP_STABLEFX_ADDRESS_MISMATCH',
  STABLEFX_CONTRACT_TRADE_ID_MISSING:
    'USER_SWAP_STABLEFX_CONTRACT_TRADE_ID_MISSING',
  STABLEFX_EXECUTION_DISABLED: 'USER_SWAP_STABLEFX_EXECUTION_DISABLED',
  STABLEFX_EXECUTION_UNSUPPORTED: 'USER_SWAP_STABLEFX_EXECUTION_UNSUPPORTED',
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

// Active backend quote provider. swapkit = Circle Stablecoin Kits (default),
// stablefx = Circle StableFX reference quotes, xylonet = XyloRouter view quotes.
// Can be selected per quote request or via WIZPAY_SWAP_PROVIDER.
export type UserSwapProvider = 'swapkit' | 'stablefx' | 'xylonet';
export const DEFAULT_SWAP_PROVIDER: UserSwapProvider = 'swapkit';

export interface UserSwapBaseRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fromAddress: string;
  toAddress?: string;
  chain: string;
}

export interface UserSwapQuoteRequest extends UserSwapBaseRequest {
  provider?: string;
  slippageBps?: number;
}

export interface UserSwapPrepareRequest extends UserSwapBaseRequest {
  slippageBps?: number;
}

export interface UserSwapStatusRequest {
  txHash: string;
  chain: string;
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
  raw: unknown;
}

export interface UserSwapTransactionPayload {
  to?: unknown;
  from?: unknown;
  data?: unknown;
  value?: unknown;
  gas?: unknown;
  gasPrice?: unknown;
  maxFeePerGas?: unknown;
  maxPriorityFeePerGas?: unknown;
  chainId?: unknown;
  abi?: unknown;
  functionName?: unknown;
  args?: unknown;
  raw: unknown;
}

export interface UserSwapPrepareResponse {
  tokenIn: UserSwapToken;
  tokenOut: UserSwapToken;
  amountIn: string;
  fromAddress: string;
  toAddress: string;
  chain: UserSwapChain;
  slippageBps?: number;
  expectedOutput?: unknown;
  minimumOutput?: unknown;
  transaction: UserSwapTransactionPayload;
  raw: unknown;
}

export interface UserSwapStatusResponse {
  txHash: string;
  chain: UserSwapChain;
  status?: unknown;
  raw: unknown;
}
