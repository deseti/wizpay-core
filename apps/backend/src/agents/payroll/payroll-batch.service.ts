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
   * Recipients are grouped by targetToken first so each batch contains only
   * one targetToken. This ensures the frontend can execute each batch as a
   * same-token payout (e.g., all USDC or all EURC) without mixing.
   */
  splitIntoBatches(recipients: ValidatedRecipient[]): PayrollBatch[] {
    // Group recipients by targetToken
    const groups = new Map<string, ValidatedRecipient[]>();

    for (const recipient of recipients) {
      const token = recipient.targetToken;
      const group = groups.get(token);

      if (group) {
        group.push(recipient);
      } else {
        groups.set(token, [recipient]);
      }
    }

    const batches: PayrollBatch[] = [];

    // Process each targetToken group, splitting into chunks of MAX_BATCH_SIZE
    for (const [, groupRecipients] of groups) {
      for (
        let i = 0;
        i < groupRecipients.length;
        i += PayrollBatchService.MAX_BATCH_SIZE
      ) {
        const chunk = groupRecipients.slice(
          i,
          i + PayrollBatchService.MAX_BATCH_SIZE,
        );

        const totalAmount = chunk.reduce((sum, r) => sum + r.amountUnits, 0n);

        batches.push({
          index: batches.length,
          recipients: chunk,
          totalAmount,
        });
      }
    }

    this.logger.log(
      `Split ${recipients.length} recipients into ${batches.length} batch(es) across ${groups.size} token group(s)`,
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
