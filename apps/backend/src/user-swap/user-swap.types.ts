import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_USDC,
} from './mainnet-uniswap-v4-protocol';

export const USER_SWAP_ALLOWED_CHAIN = 'ARC-MAINNET' as const;

export const USER_SWAP_USDC_ADDRESS = ARC_MAINNET_UNISWAP_V4_USDC;
export const USER_SWAP_EURC_ADDRESS = ARC_MAINNET_UNISWAP_V4_EURC;

export const USER_SWAP_ERROR_CODES = {
  DISABLED: 'USER_SWAP_DISABLED',
  INVALID_REQUEST: 'USER_SWAP_INVALID_REQUEST',
  UNSUPPORTED_CHAIN: 'USER_SWAP_UNSUPPORTED_CHAIN',
} as const;

export type UserSwapChain = typeof USER_SWAP_ALLOWED_CHAIN;
export type UserSwapToken = 'USDC' | 'EURC';

export type UserSwapProvider = 'uniswap-v4';

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

export interface UserSwapNormalizedQuote {
  tokenIn: UserSwapToken;
  tokenOut: UserSwapToken;
  amountIn: string;
  fromAddress: string;
  toAddress: string;
  chain: UserSwapChain;
  provider: UserSwapProvider;
  slippageBps: number;
  deadline: number;
  tokenInAddress: string;
  tokenOutAddress: string;
  recipientAddress: string;
  raw: unknown;
}
