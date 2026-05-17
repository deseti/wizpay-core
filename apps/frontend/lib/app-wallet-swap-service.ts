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
  status:
    | "awaiting_user_deposit"
    | "deposit_submitted"
    | "deposit_confirmed"
    | "treasury_swap_pending"
    | "treasury_swap_submitted"
    | "treasury_swap_confirmed"
    | "payout_pending"
    | "payout_submitted"
    | "payout_confirmed"
    | "completed"
    | "execution_failed";
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
  payoutTxHash?: string;
  payoutAmount?: string;
  payoutSubmittedAt?: string;
  payoutConfirmedAt?: string;
  rawPayout?: unknown;
  completedAt?: string;
  executionError?: string;
  createdAt: string;
  updatedAt: string;
  executionEnabled: boolean;
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

export async function attachAppWalletSwapDepositTxHash(
  operationId: string,
  params: AppWalletSwapDepositTxHashRequest,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/deposit-txhash`,
    {
      method: "POST",
      body: JSON.stringify(params),
    },
  );
}

export async function resolveAppWalletSwapDepositTxHash(
  operationId: string,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/resolve-deposit-txhash`,
    {
      method: "POST",
    },
  );
}

export async function confirmAppWalletSwapDeposit(
  operationId: string,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/confirm-deposit`,
    {
      method: "POST",
    },
  );
}

export async function executeAppWalletSwapOperation(
  operationId: string,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/execute`,
    {
      method: "POST",
    },
  );
}
