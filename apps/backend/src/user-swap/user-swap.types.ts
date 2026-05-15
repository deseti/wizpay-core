export const USER_SWAP_ALLOWED_CHAIN = 'ARC-TESTNET' as const;
export const USER_SWAP_API_BASE_URL = 'https://api.circle.com' as const;

export const USER_SWAP_ERROR_CODES = {
  CIRCLE_STABLECOIN_API_FAILED: 'CIRCLE_STABLECOIN_API_FAILED',
  CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE:
    'CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE',
  DISABLED: 'USER_SWAP_DISABLED',
  INVALID_REQUEST: 'USER_SWAP_INVALID_REQUEST',
  KIT_KEY_MISSING: 'USER_SWAP_KIT_KEY_MISSING',
  TESTNET_DISABLED: 'USER_SWAP_TESTNET_DISABLED',
  UNSUPPORTED_CHAIN: 'USER_SWAP_UNSUPPORTED_CHAIN',
} as const;

export type UserSwapChain = typeof USER_SWAP_ALLOWED_CHAIN;
export type UserSwapToken = 'USDC' | 'EURC';

export interface UserSwapBaseRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fromAddress: string;
  toAddress?: string;
  chain: string;
}

export interface UserSwapQuoteRequest extends UserSwapBaseRequest {}

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
  expectedOutput?: unknown;
  minimumOutput?: unknown;
  fees?: unknown;
  expiresAt?: unknown;
  quoteId?: unknown;
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
