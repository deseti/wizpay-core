import { backendFetch } from "@/lib/backend-api";
import type { TokenSymbol } from "@/lib/wizpay";

export const USER_SWAP_CHAIN = "ARC-TESTNET" as const;

/**
 * Backend swap quote provider.
 * - "swapkit": Circle Stablecoin Kits (default, supports prepare/execute).
 * - "stablefx": Circle StableFX quotes; /swap executes through StableFX lifecycle endpoints.
 */
export type UserSwapProvider = "swapkit" | "stablefx";

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
  expectedOutput?: unknown;
  minimumOutput?: unknown;
  raw: unknown;
}

export interface UserSwapPrepareResponse extends UserSwapQuoteResponse {
  slippageBps?: number;
  transaction: UserSwapTransactionPayload;
}

export interface StablefxTradableQuoteRequest {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  fromAddress: string;
  recipientAddress?: string;
  chain: typeof USER_SWAP_CHAIN;
}

export interface StablefxTradableQuoteResponse {
  id?: string;
  quoteId?: string;
  status?: string;
  rate?: unknown;
  from?: { currency?: string; amount?: string };
  to?: { currency?: string; amount?: string };
  typedData?: Record<string, unknown>;
  expiresAt?: string;
  expiration?: string;
  raw?: unknown;
  [key: string]: unknown;
}

export interface StablefxCreateTradeRequest {
  idempotencyKey: string;
  quoteId: string;
  address: string;
  selectedAddress?: string;
  message: Record<string, unknown>;
  signature: string;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  walletMode: "circle" | "external";
}

export interface StablefxTradeResponse {
  id?: string;
  contractTradeId?: string;
  data?: Record<string, unknown>;
  trade?: Record<string, unknown>;
  status?: string;
  rate?: unknown;
  from?: { currency?: string; amount?: string };
  to?: { currency?: string; amount?: string };
  quoteId?: string;
  settlementTransactionHash?: string | null;
  [key: string]: unknown;
}

export interface StablefxFundingPresignResponse {
  deliverables?: unknown;
  receivables?: unknown;
  typedData?: Record<string, unknown>;
  [key: string]: unknown;
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

export async function createStablefxTradableQuote(
  params: StablefxTradableQuoteRequest,
): Promise<StablefxTradableQuoteResponse> {
  return backendFetch<StablefxTradableQuoteResponse>(
    "/user-swap/stablefx/quote",
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}

export async function createStablefxTrade(
  params: StablefxCreateTradeRequest,
): Promise<StablefxTradeResponse> {
  return backendFetch<StablefxTradeResponse>("/user-swap/stablefx/trades", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function createStablefxFundingPresign(params: {
  contractTradeId: string;
}): Promise<StablefxFundingPresignResponse> {
  return backendFetch<StablefxFundingPresignResponse>(
    "/user-swap/stablefx/funding-presign",
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}

export async function fundStablefxTrade(params: {
  permit2: Record<string, unknown>;
  signature: string;
}): Promise<Record<string, unknown>> {
  return backendFetch<Record<string, unknown>>("/user-swap/stablefx/fund", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getStablefxTrade(
  tradeId: string,
): Promise<StablefxTradeResponse> {
  return backendFetch<StablefxTradeResponse>(
    `/user-swap/stablefx/trades/${encodeURIComponent(tradeId)}`,
  );
}
