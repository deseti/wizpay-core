import { backendFetch } from "@/lib/backend-api";
import type { TokenSymbol } from "@/lib/wizpay";

export const USER_SWAP_CHAIN = "ARC-TESTNET" as const;

export interface UserSwapQuoteRequest {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  fromAddress: string;
  toAddress?: string;
  chain: typeof USER_SWAP_CHAIN;
  slippageBps?: number;
}

export interface UserSwapPrepareRequest extends UserSwapQuoteRequest {
  slippageBps?: number;
}

export interface UserSwapTransactionPayload {
  signature?: unknown;
  executionParams?: unknown;
  to?: unknown;
  target?: unknown;
  data?: unknown;
  value?: unknown;
  gas?: unknown;
  gasLimit?: unknown;
  raw?: unknown;
}

export interface UserSwapQuoteResponse {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  fromAddress: string;
  toAddress: string;
  chain: typeof USER_SWAP_CHAIN;
  expectedOutput?: unknown;
  minimumOutput?: unknown;
  raw: unknown;
}

export interface UserSwapPrepareResponse extends UserSwapQuoteResponse {
  slippageBps?: number;
  transaction: UserSwapTransactionPayload;
}

export async function quoteUserSwap(
  params: UserSwapQuoteRequest,
): Promise<UserSwapQuoteResponse> {
  return backendFetch<UserSwapQuoteResponse>("/user-swap/quote", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function prepareUserSwap(
  params: UserSwapPrepareRequest,
): Promise<UserSwapPrepareResponse> {
  return backendFetch<UserSwapPrepareResponse>("/user-swap/prepare", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
