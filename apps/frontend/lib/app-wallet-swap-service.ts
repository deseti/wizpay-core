import { backendFetch } from "@/lib/backend-api";
import type { TokenSymbol } from "@/lib/wizpay";

export const APP_WALLET_SWAP_CHAIN = "ARC-TESTNET" as const;
export const APP_WALLET_SWAP_OPERATION_MODE = "treasury-mediated" as const;

export interface AppWalletSwapQuoteRequest {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  fromAddress: string;
  chain: typeof APP_WALLET_SWAP_CHAIN;
}

export interface AppWalletSwapQuoteResponse {
  operationMode: typeof APP_WALLET_SWAP_OPERATION_MODE;
  sourceChain: typeof APP_WALLET_SWAP_CHAIN;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  treasuryDepositAddress: string;
  expectedOutput: unknown;
  minimumOutput: unknown;
  expiresAt: string;
  status: "quoted";
  quoteId?: unknown;
  rawQuote?: unknown;
}

export interface AppWalletSwapOperationResponse
  extends Omit<AppWalletSwapQuoteResponse, "status"> {
  operationId: string;
  status: "awaiting_user_deposit" | "deposit_submitted";
  userWalletAddress: string;
  depositTxHash?: string;
  circleTransactionId?: string;
  circleReferenceId?: string;
  depositSubmittedAt?: string;
  createdAt: string;
  updatedAt: string;
  executionEnabled: boolean;
}

export interface AppWalletSwapDepositRequest {
  depositTxHash?: string;
  circleTransactionId?: string;
  circleReferenceId?: string;
}

export async function quoteAppWalletSwap(
  params: AppWalletSwapQuoteRequest,
): Promise<AppWalletSwapQuoteResponse> {
  return backendFetch<AppWalletSwapQuoteResponse>("/app-wallet-swap/quote", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function createAppWalletSwapOperation(
  params: AppWalletSwapQuoteRequest,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    "/app-wallet-swap/operations",
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}

export async function getAppWalletSwapOperation(
  operationId: string,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}`,
  );
}

export async function submitAppWalletSwapDeposit(
  operationId: string,
  params: AppWalletSwapDepositRequest,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/deposit`,
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}
