import type { CircleTransactionStatusResult } from '../adapters/circle.service';

export interface PayrollFxApprovalReconciliation {
  allowanceSufficient: boolean;
  transaction: CircleTransactionStatusResult | null;
}

export interface PayrollFxPayoutResult {
  transactionId: string | null;
  transactionHash: string | null;
}
