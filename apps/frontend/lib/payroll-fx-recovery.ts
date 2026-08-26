/**
 * Recoverable error for a user-controlled payroll pre-swap.
 *
 * This carries only public transaction context. Recovery must resume the
 * persisted user-controlled operation; it must never submit a treasury or
 * developer-controlled transfer.
 */
export class PayrollFxRecoveryError extends Error {
  fundingCircleTxId: string | null = null;
  fundingChallengeId: string | null = null;
  fundingTxHash: string | null = null;
  payoutTxHash: string | null = null;
  xylonetOperationId: string | null;
  settlementTxHash: string | null;
  step: string;

  constructor(
    message: string,
    context: {
      xylonetOperationId?: string | null;
      settlementTxHash?: string | null;
      step: string;
    },
  ) {
    super(message);
    this.name = "PayrollFxRecoveryError";
    this.xylonetOperationId = context.xylonetOperationId ?? null;
    this.settlementTxHash = context.settlementTxHash ?? null;
    this.step = context.step;
  }
}
