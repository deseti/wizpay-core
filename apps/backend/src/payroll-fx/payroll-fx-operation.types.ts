export const PAYROLL_FX_EXECUTION_PROVIDERS = ['stablefx', 'swapkit'] as const;
export type PayrollFxExecutionProvider =
  (typeof PAYROLL_FX_EXECUTION_PROVIDERS)[number];

export const PAYROLL_FX_OPERATION_STATUSES = [
  'created',
  'quote_pending',
  'quote_ready',
  'approval_pending',
  'submitted',
  'funding_pending',
  'settlement_pending',
  'settled',
  'payout_pending',
  'completed',
  'recovery_required',
  'failed',
] as const;
export type PayrollFxOperationStatus =
  (typeof PAYROLL_FX_OPERATION_STATUSES)[number];

export type PayrollFxDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | PayrollFxDiagnosticValue[]
  | { [key: string]: PayrollFxDiagnosticValue };

export interface PayrollFxOperationIntent {
  idempotencyKey: string;
  walletMode: 'app';
  executionProvider: PayrollFxExecutionProvider;
  sourceTokenAddress: string;
  destinationTokenAddress: string;
  sourceTokenSymbol: string;
  destinationTokenSymbol: string;
  network: string;
  sourceWalletAddress: string;
  treasuryWalletAddress: string;
  amountInBaseUnits: string;
  requestedMinimumOutputBaseUnits?: string | null;
}

export interface PayrollFxLeaseFence {
  leaseId: string;
}

export interface PayrollFxOperation extends PayrollFxOperationIntent {
  operationId: string;
  taskId: string | null;
  status: PayrollFxOperationStatus;
  failureCode: string | null;
  failureMessage: string | null;
  quoteId: string | null;
  quoteExpiresAt: Date | null;
  expectedOutputBaseUnits: string | null;
  actualOutputBaseUnits: string | null;
  providerOperationId: string | null;
  approvalTransactionId: string | null;
  approvalTransactionHash: string | null;
  fundingTransactionId: string | null;
  fundingTransactionHash: string | null;
  settlementTransactionId: string | null;
  settlementTransactionHash: string | null;
  payoutTransactionId: string | null;
  payoutTransactionHash: string | null;
  approvalTargetAddress: string | null;
  lastProviderStatus: string | null;
  diagnosticSnapshot: PayrollFxDiagnosticValue;
  executionLeaseId: string | null;
  executionLeaseExpiresAt: Date | null;
  executionAttemptCount: number;
  lastAttemptStartedAt: Date | null;
  lastAttemptFinishedAt: Date | null;
  recoveryFromStatus: PayrollFxOperationStatus | null;
  submittedAt: Date | null;
  fundingConfirmedAt: Date | null;
  settledAt: Date | null;
  payoutConfirmedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayrollFxQuoteEvidence {
  quoteId: string;
  approvalTargetAddress?: string | null;
  quoteExpiresAt?: Date | null;
  expectedOutputBaseUnits?: string | null;
  lastProviderStatus?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxApprovalEvidence {
  approvalTransactionId?: string | null;
  approvalTransactionHash?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxSubmissionEvidence {
  providerOperationId: string;
  approvalTransactionId?: string | null;
  approvalTransactionHash?: string | null;
  submittedAt: Date;
  lastProviderStatus?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxFundingEvidence {
  fundingTransactionId?: string | null;
  fundingTransactionHash?: string | null;
  fundingConfirmedAt: Date;
  lastProviderStatus?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxSettlementEvidence {
  actualOutputBaseUnits: string;
  settlementTransactionId?: string | null;
  settlementTransactionHash: string;
  settledAt: Date;
  lastProviderStatus?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxPayoutEvidence {
  payoutTransactionId?: string | null;
  payoutTransactionHash?: string | null;
  payoutConfirmedAt: Date;
  completedAt: Date;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxPayoutSubmissionEvidence {
  payoutTransactionId?: string | null;
  payoutTransactionHash?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}

export interface PayrollFxFailureEvidence {
  status: 'recovery_required' | 'failed';
  failureCode: string;
  failureMessage: string;
  lastProviderStatus?: string | null;
  diagnosticSnapshot?: PayrollFxDiagnosticValue;
}
