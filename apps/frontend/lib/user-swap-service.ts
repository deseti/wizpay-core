import { backendFetch } from "@/lib/backend-api";
import { getMainnetUniswapV4UnavailableState } from "@/lib/mainnet-uniswap-v4";
import type { TokenSymbol } from "@/lib/wizpay";

export const USER_SWAP_CHAIN = "ARC-MAINNET" as const;

/** Standalone swap quotes and execution resolve through Mainnet Uniswap V4 only. */
export type UserSwapProvider = "mainnet-uniswap-v4";

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
  /** Active backend provider that produced this quote. */
  provider?: UserSwapProvider;
  expiresAt?: string;
  expectedOutput?: unknown;
  minimumOutput?: unknown;
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

export interface UserSwapPrepareResponse extends UserSwapQuoteResponse {
  slippageBps?: number;
  transaction: UserSwapTransactionPayload;
}

function assertMainnetUserSwapRequest(params: UserSwapQuoteRequest) {
  if (params.chain !== USER_SWAP_CHAIN) {
    throw new Error("Standalone swaps support Arc Mainnet only.");
  }
  if (params.tokenIn === params.tokenOut) {
    throw new Error("tokenIn and tokenOut must be different.");
  }
  if (
    params.toAddress &&
    params.toAddress.toLowerCase() !== params.fromAddress.toLowerCase()
  ) {
    throw new Error("toAddress must equal the connected wallet address.");
  }
}

function assertMainnetSwapGate() {
  const gate = getMainnetUniswapV4UnavailableState();
  if (!gate.available || !gate.executable) {
    throw new Error(gate.message);
  }
}

export async function quoteUserSwap(
  params: UserSwapQuoteRequest,
  init?: Pick<RequestInit, "signal">,
): Promise<UserSwapQuoteResponse> {
  assertMainnetUserSwapRequest(params);
  assertMainnetSwapGate();
  return backendFetch<UserSwapQuoteResponse>("/user-swap/quote", {
    method: "POST",
    body: JSON.stringify(params),
    ...init,
  });
}

export async function prepareUserSwap(
  params: UserSwapPrepareRequest,
): Promise<UserSwapPrepareResponse> {
  assertMainnetUserSwapRequest(params);
  assertMainnetSwapGate();
  return backendFetch<UserSwapPrepareResponse>("/user-swap/prepare", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
