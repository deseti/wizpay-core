import { backendFetch } from "@/lib/backend-api";
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

export interface MainnetSwapPrepareRequest {
  chainId: 5042;
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  recipient: string;
  walletAddress: string;
  walletControl: "external-wallet";
  slippageBps: number;
  deadline: number;
  quoteResult: unknown;
}

export interface MainnetSwapPlan {
  walletControl: "external-wallet";
  chainId: 5042;
  poolKey: unknown;
  poolId: string;
  quote: {
    zeroForOne: boolean;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    amountOut: string;
    gasEstimate: string;
    minAmountOut: string;
    minHopPriceX36: string;
    slippageBps: number;
    poolId: string;
  };
  approvals: ReadonlyArray<{
    to: string;
    data: `0x${string}`;
    value: string;
    description: string;
  }>;
  swap: {
    to: string;
    data: `0x${string}`;
    value: string;
    description: string;
  };
  permit2: null;
  recipient: string;
  deadline: number;
  executable: false;
}

export async function prepareMainnetSwap(
  params: MainnetSwapPrepareRequest,
): Promise<MainnetSwapPlan> {
  return backendFetch<MainnetSwapPlan>("/user-swap/mainnet/prepare", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function confirmMainnetSwap(
  transactionHash: `0x${string}`,
  sessionToken: string,
) {
  return backendFetch<{
    id: string;
    transactionHash: string;
  }>("/user-swap/mainnet/confirm", {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ transactionHash }),
  });
}

export async function fetchMainnetSwapReadiness(): Promise<{
  available: boolean;
  executable: boolean;
  poolIdentityStatus: string;
  blockers: string[];
}> {
  return backendFetch("/user-swap/mainnet/readiness");
}

export interface PayrollCrossTokenQuoteRequest {
  tokenInAddress: string;
  tokenOutAddress: string;
  outputTotals: string;
  slippageBps: number;
  walletAddress: string;
  recipient: string;
}

export interface PayrollCrossTokenQuote {
  tokenIn: string;
  tokenOut: string;
  obligations: string;
  grossInput: string;
  feeAmount: string;
  netAmountIn: string;
  minTotalOut: string;
  minHopPriceX36: string;
  slippageBps: number;
  payrollFeeBps: string;
  quoteBlock: number;
  quotedAt: string;
  expiresAt: string;
  expiresAtBlock: number;
}

export async function fetchPayrollCrossTokenQuote(
  params: PayrollCrossTokenQuoteRequest,
): Promise<PayrollCrossTokenQuote> {
  return backendFetch<PayrollCrossTokenQuote>(
    "/user-swap/mainnet/payroll-quote",
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}

export async function quoteUserSwap(
  params: UserSwapQuoteRequest,
  init?: Pick<RequestInit, "signal">,
): Promise<UserSwapQuoteResponse> {
  assertMainnetUserSwapRequest(params);
  // No static frontend gate: the backend live quorum (pool state on two
  // RPCs, executor config, live quoter) is the single authoritative
  // readiness state and fails closed with specific blockers.
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
  return backendFetch<UserSwapPrepareResponse>("/user-swap/prepare", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
