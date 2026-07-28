export interface PayrollFxStablefxLifecycleRequest {
  sourceToken: string;
  targetToken: string;
  sourceAmount: string;
  walletAddress?: string;
  referenceId: string;
}

export interface PayrollFxStablefxLifecycleResult {
  sourceToken: string;
  targetToken: string;
  sourceAmount: string;
  targetAmount: string;
  txHash: string | null;
  status: 'settled';
  operationId?: string;
}

export interface PayrollFxStablefxPayoutSubmission {
  transactionId?: string | null;
  transactionHash?: string | null;
}

export interface PayrollFxStablefxPayoutCompletion {
  transactionId?: string | null;
  transactionHash?: string | null;
  confirmedAt: Date;
}
