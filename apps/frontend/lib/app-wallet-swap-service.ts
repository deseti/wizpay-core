import { backendFetch } from "@/lib/backend-api";
import type { TokenSymbol } from "@/lib/wizpay";

export const APP_WALLET_SWAP_CHAIN = "ARC-TESTNET" as const;
export const APP_WALLET_SWAP_OPERATION_MODE = "treasury-mediated" as const;
export type AppWalletSwapProvider = "stablefx" | "swapkit" | "xylonet";

/**
 * Backend domain error code returned when Circle cannot route the requested
 * direction at the requested amount. Direction- and amount-dependent, so it is
 * never a permanent block on the pair.
 */
export const SWAPKIT_ROUTE_UNAVAILABLE_CODE = "SWAPKIT_ROUTE_UNAVAILABLE";

export interface AppWalletSwapQuoteRequest {
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  fromAddress: string;
  chain: typeof APP_WALLET_SWAP_CHAIN;
  provider?: AppWalletSwapProvider;
}

export interface AppWalletSwapQuoteResponse {
  operationMode:
    | typeof APP_WALLET_SWAP_OPERATION_MODE
    | "direct-user-controlled";
  executionMode?: "direct-user-controlled";
  sourceChain: typeof APP_WALLET_SWAP_CHAIN;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  treasuryDepositAddress?: string;
  expectedOutput: unknown;
  minimumOutput: unknown;
  expiresAt: string;
  status: "quoted";
  provider?: AppWalletSwapProvider;
  quoteId?: unknown;
  rawQuote?: unknown;
  circleWalletId?: string;
  walletAddress?: string;
  executorAddress?: string;
  routerAddress?: string;
  recipientAddress?: string;
  gasReserveUnits?: string;
  gasReserveSource?: "estimate" | "fallback";
}

export interface AppWalletSwapOperationResponse extends Omit<
  AppWalletSwapQuoteResponse,
  "status"
> {
  operationId: string;
  status:
    | "awaiting_user_deposit"
    | "deposit_submitted"
    | "deposit_confirmed"
    | "stablefx_quote_requested"
    | "stablefx_trade_created"
    | "stablefx_contract_ready"
    | "stablefx_funded"
    | "stablefx_settled_to_treasury"
    | "treasury_swap_pending"
    | "treasury_swap_submitted"
    | "treasury_swap_confirmed"
    | "payout_pending"
    | "payout_submitted"
    | "payout_confirmed"
    | "completed"
    | "execution_recovery_required"
    | "refund_pending"
    | "refund_submitted"
    | "refunded"
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
  stablefxFundingRequestedAt?: string;
  stablefxFundedAt?: string;
  payoutTxHash?: string;
  payoutAmount?: string;
  payoutSubmittedAt?: string;
  payoutConfirmedAt?: string;
  rawPayout?: unknown;
  refundTransactionId?: string;
  refundTxHash?: string;
  refundAmount?: string;
  refundSubmittedAt?: string;
  refundConfirmedAt?: string;
  rawRefund?: unknown;
  completedAt?: string;
  executionError?: string;
  createdAt: string;
  updatedAt: string;
  executionEnabled: boolean;
  executionMode?: "direct-user-controlled";
  lifecycleStage?: AppWalletXylonetLifecycleStage;
  terminalStatus?: AppWalletXylonetTerminalStatus;
  failureReason?: string;
  approvalChallengeId?: string;
  swapChallengeId?: string;
  approvalTransactionId?: string;
  swapTransactionId?: string;
  approvalTransactionHash?: string;
  swapTransactionHash?: string;
  walletAddress?: string;
  executorAddress?: string;
  routerAddress?: string;
  recipientAddress?: string;
}

export type AppWalletXylonetLifecycleStage =
  | "created"
  | "approval_challenge_creating"
  | "awaiting_approval_confirmation"
  | "approval_submitted"
  | "approval_confirmed"
  | "swap_challenge_creating"
  | "awaiting_swap_confirmation"
  | "swap_submitted"
  | "output_verified"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "expired"
  | "timed_out";

export type AppWalletXylonetTerminalStatus =
  | "confirmed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "expired"
  | "timed_out";

export interface AppWalletXylonetOperationResponse {
  operationId: string;
  executionMode: "direct-user-controlled";
  provider: "xylonet";
  applicationUserId: string;
  circleWalletId: string;
  walletAddress: string;
  chain: typeof APP_WALLET_SWAP_CHAIN;
  chainId: 5042002;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  expectedOutput: string;
  minimumOutput: string;
  verifiedActualOutput?: string;
  slippageBps: number;
  feeBps: number;
  routerAddress: string;
  executorAddress: string;
  recipientAddress: string;
  deadline: string;
  lifecycleStage: AppWalletXylonetLifecycleStage;
  terminalStatus?: AppWalletXylonetTerminalStatus;
  failureReason?: string;
  approvalChallengeId?: string;
  swapChallengeId?: string;
  approvalTransactionId?: string;
  swapTransactionId?: string;
  approvalTransactionHash?: string;
  swapTransactionHash?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AppWalletXylonetRequest {
  idempotencyKey: string;
  walletId: string;
  walletAddress: string;
  chain: typeof APP_WALLET_SWAP_CHAIN;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  amountIn: string;
  slippageBps: number;
}

function userTokenHeaders(userToken: string) {
  return { "X-User-Token": userToken };
}

export async function quoteAppWalletXylonetSwap(
  params: AppWalletXylonetRequest,
  userToken: string,
  options: Pick<RequestInit, "signal"> = {},
): Promise<AppWalletSwapQuoteResponse> {
  return backendFetch<AppWalletSwapQuoteResponse>(
    "/app-wallet-swap/xylonet/quote",
    {
      method: "POST",
      headers: userTokenHeaders(userToken),
      body: JSON.stringify(params),
      ...options,
    },
  );
}

export async function createAppWalletXylonetOperation(
  params: AppWalletXylonetRequest,
  userToken: string,
) {
  return backendFetch<AppWalletXylonetOperationResponse>(
    "/app-wallet-swap/xylonet/operations",
    {
      method: "POST",
      headers: userTokenHeaders(userToken),
      body: JSON.stringify(params),
    },
  );
}

export async function getAppWalletXylonetOperation(
  operationId: string,
  userToken: string,
) {
  return backendFetch<AppWalletXylonetOperationResponse>(
    `/app-wallet-swap/xylonet/operations/${encodeURIComponent(operationId)}`,
    { headers: userTokenHeaders(userToken) },
  );
}

async function postXylonetOperation(
  operationId: string,
  action: string,
  userToken: string,
  body?: unknown,
) {
  return backendFetch<AppWalletXylonetOperationResponse>(
    `/app-wallet-swap/xylonet/operations/${encodeURIComponent(operationId)}/${action}`,
    {
      method: "POST",
      headers: userTokenHeaders(userToken),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

export const createAppWalletXylonetApprovalChallenge = (
  operationId: string,
  userToken: string,
) => postXylonetOperation(operationId, "approval-challenge", userToken);
export const createAppWalletXylonetSwapChallenge = (
  operationId: string,
  userToken: string,
) => postXylonetOperation(operationId, "swap-challenge", userToken);
export const pollAppWalletXylonetOperation = (
  operationId: string,
  userToken: string,
) => postXylonetOperation(operationId, "poll", userToken);
export const recordAppWalletXylonetChallengeResult = (
  operationId: string,
  stage: "approval" | "swap",
  result: {
    status:
      | "PENDING"
      | "IN_PROGRESS"
      | "INITIATED"
      | "SUBMITTED"
      | "COMPLETE"
      | "COMPLETED"
      | "SUCCESS"
      | "SUCCEEDED"
      | "FAILED"
      | "CANCELLED"
      | "CANCELED"
      | "REJECTED"
      | "DENIED"
      | "EXPIRED"
      | "TIMED_OUT";
    reason?: string;
  },
  userToken: string,
) => postXylonetOperation(operationId, `${stage}-result`, userToken, result);

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
  options: Pick<RequestInit, "signal"> = {},
): Promise<AppWalletSwapQuoteResponse> {
  return backendFetch<AppWalletSwapQuoteResponse>("/app-wallet-swap/quote", {
    method: "POST",
    body: JSON.stringify(params),
    ...options,
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    return await backendFetch<AppWalletSwapOperationResponse>(
      `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/execute`,
      {
        method: "POST",
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function refundAppWalletSwapOperation(
  operationId: string,
): Promise<AppWalletSwapOperationResponse> {
  return backendFetch<AppWalletSwapOperationResponse>(
    `/app-wallet-swap/operations/${encodeURIComponent(operationId)}/refund`,
    {
      method: "POST",
    },
  );
}
