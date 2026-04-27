import { Injectable, Logger } from '@nestjs/common';
import type { ValidatedRecipient } from './payroll-validation.service';

// ─── Types ──────────────────────────────────────────────────────────

export interface PayrollBatch {
  index: number;
  recipients: ValidatedRecipient[];
  totalAmount: bigint;
}

export interface PayrollBatchTotals {
  totalAmount: bigint;
  totalRecipients: number;
  totalBatches: number;
  batchBreakdown: Array<{
    index: number;
    recipientCount: number;
    amount: bigint;
  }>;
}

// ─── Service ────────────────────────────────────────────────────────

/**
 * PayrollBatchService extracts the batching and aggregation logic
 * that was previously embedded in the frontend's `useBatchPayroll` hook
 * and `useWizPayState.importRecipients`.
 *
 * Responsibilities:
 * - Split recipients into batches of MAX_BATCH_SIZE
 * - Calculate per-batch totals and approval requirements
 * - Aggregate totals across all batches
 */
@Injectable()
export class PayrollBatchService {
  private readonly logger = new Logger(PayrollBatchService.name);

  static readonly MAX_BATCH_SIZE = 50;

  /**
   * Split a flat recipient list into ordered batches of up to MAX_BATCH_SIZE.
   */
  splitIntoBatches(recipients: ValidatedRecipient[]): PayrollBatch[] {
    const batches: PayrollBatch[] = [];

    for (
      let i = 0;
      i < recipients.length;
      i += PayrollBatchService.MAX_BATCH_SIZE
    ) {
      const chunk = recipients.slice(
        i,
        i + PayrollBatchService.MAX_BATCH_SIZE,
      );

      const totalAmount = chunk.reduce(
        (sum, r) => sum + r.amountUnits,
        0n,
      );

      batches.push({
        index: batches.length,
        recipients: chunk,
        totalAmount,
      });
    }

    this.logger.log(
      `Split ${recipients.length} recipients into ${batches.length} batch(es)`,
    );

    return batches;
  }

  /**
   * Calculate aggregate totals across all batches.
   */
  calculateTotals(batches: PayrollBatch[]): PayrollBatchTotals {
    const totalAmount = batches.reduce(
      (sum, batch) => sum + batch.totalAmount,
      0n,
    );
    const totalRecipients = batches.reduce(
      (sum, batch) => sum + batch.recipients.length,
      0,
    );

    return {
      totalAmount,
      totalRecipients,
      totalBatches: batches.length,
      batchBreakdown: batches.map((batch) => ({
        index: batch.index,
        recipientCount: batch.recipients.length,
        amount: batch.totalAmount,
      })),
    };
  }

  /**
   * Calculate the approval amount required for a specific batch.
   * In cross-currency mode, only FX-routed amounts need approval.
   * Same-token transfers do not require approval to the FX engine.
   */
  calculateApprovalRequirement(
    batch: PayrollBatch,
    sourceToken: string,
  ): bigint {
    return batch.recipients.reduce((total, recipient) => {
      // Same-token transfers don't require FX engine approval
      if (recipient.targetToken === sourceToken) {
        return total;
      }
      return total + recipient.amountUnits;
    }, 0n);
  }
}
