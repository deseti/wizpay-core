export const APP_WALLET_XYLONET_MODE = 'direct-user-controlled' as const;
export const APP_WALLET_XYLONET_PROVIDER = 'xylonet' as const;

export type AppWalletXylonetStage =
  | 'created'
  | 'approval_challenge_creating'
  | 'awaiting_approval_confirmation'
  | 'approval_submitted'
  | 'approval_confirmed'
  | 'swap_challenge_creating'
  | 'awaiting_swap_confirmation'
  | 'swap_submitted'
  | 'output_verified'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'timed_out';

export type AppWalletXylonetTerminalStatus =
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'timed_out';

export interface AppWalletXylonetOperationResponse {
  operationId: string;
  executionMode: typeof APP_WALLET_XYLONET_MODE;
  provider: typeof APP_WALLET_XYLONET_PROVIDER;
  applicationUserId: string;
  circleWalletId: string;
  walletAddress: string;
  chain: 'ARC-TESTNET';
  chainId: 5_042_002;
  tokenIn: 'USDC' | 'EURC';
  tokenOut: 'USDC' | 'EURC';
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  expectedOutput: string;
  minimumOutput: string;
  slippageBps: number;
  feeBps: number;
  routerAddress: string;
  executorAddress: string;
  recipientAddress: string;
  deadline: string;
  lifecycleStage: AppWalletXylonetStage;
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

export const APP_WALLET_XYLONET_ERRORS = {
  DISABLED: 'APP_WALLET_XYLONET_USER_CONTROLLED_DISABLED',
  CONFIG_INVALID: 'APP_WALLET_XYLONET_CONFIG_INVALID',
  AUTH_REQUIRED: 'APP_WALLET_XYLONET_USER_TOKEN_REQUIRED',
  WALLET_MISMATCH: 'APP_WALLET_XYLONET_WALLET_MISMATCH',
  OPERATION_FORBIDDEN: 'APP_WALLET_XYLONET_OPERATION_FORBIDDEN',
  INVALID_REQUEST: 'APP_WALLET_XYLONET_INVALID_REQUEST',
  INVALID_STAGE: 'APP_WALLET_XYLONET_INVALID_STAGE',
  CIRCLE_FAILED: 'APP_WALLET_XYLONET_CIRCLE_FAILED',
  TRANSACTION_FAILED: 'APP_WALLET_XYLONET_TRANSACTION_FAILED',
  RECEIPT_TIMEOUT: 'APP_WALLET_XYLONET_RECEIPT_TIMEOUT',
  VERIFICATION_FAILED: 'APP_WALLET_XYLONET_VERIFICATION_FAILED',
} as const;
