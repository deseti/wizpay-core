import { Injectable, Logger } from '@nestjs/common';
import { StableFXRfqClient } from './stablefx-rfq-client.service';

/**
 * Represents a single leg in a batch payroll submission.
 */
export interface BatchLeg {
  recipient: string;
  amount: string;
  sourceToken: string;
  destinationToken: string;
  minOutput: string;
}

/**
 * Result of batch pre-validation.
 * If valid is false, the entire batch is rejected with per-leg error details.
 */
export interface BatchValidationResult {
  valid: boolean;
  errors: Array<{
    legIndex: number;
    recipient: string;
    amount: string;
    error: string;
  }>;
}

/**
 * Result of cross-currency batch execution.
 * Contains per-leg results and a batch summary.
 */
export interface BatchExecutionResult {
  batchReferenceId: string;
  totalLegs: number;
  succeeded: number;
  failed: number;
  totalDisbursed: string;
  legResults: Array<{
    legIndex: number;
    recipient: string;
    amount: string;
    success: boolean;
    quoteId?: string;
    tradeId?: string;
    reason?: string;
    timestamp: string;
  }>;
}

/** Minimum batch size. */
const BATCH_MIN_SIZE = 1;

/** Maximum batch size. */
const BATCH_MAX_SIZE = 200;

/** Minimum amount per leg (inclusive). */
const AMOUNT_MIN = 0.01;

/** Maximum amount per leg (inclusive). */
const AMOUNT_MAX = 999_999_999.99;

/** Zero address constant for validation. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * FxBatchService handles batch validation and cross-currency batch execution
 * for payroll operations.
 *
 * Responsibilities:
 * - Atomic batch pre-validation: if ANY leg fails, reject the ENTIRE batch
 * - Cross-currency batch execution: independent RFQ quotes per leg
 * - Batch summary recording on terminal state
 *
 * Requirements: 4.2, 4.3, 4.5, 4.6, 4.8
 */
@Injectable()
export class FxBatchService {
  private readonly logger = new Logger(FxBatchService.name);

  constructor(private readonly rfqClient: StableFXRfqClient) {}

  /**
   * Validates a batch of payment legs atomically.
   *
   * Validation rules:
   * - Batch size must be 1–200 legs
   * - Every recipient must be a non-zero address (not 0x0000...0000)
   * - Every amount must be a valid positive number
   * - All amounts must be in range 0.01–999,999,999.99
   *
   * If ANY leg fails validation, the entire batch is rejected with per-leg error details.
   * No legs are enqueued for execution.
   *
   * @param legs - Array of batch legs to validate
   * @returns Validation result with per-leg errors if invalid
   */
  validateBatch(legs: BatchLeg[]): BatchValidationResult {
    const errors: BatchValidationResult['errors'] = [];

    // Validate batch size
    if (!legs || legs.length < BATCH_MIN_SIZE) {
      return {
        valid: false,
        errors: [
          {
            legIndex: -1,
            recipient: '',
            amount: '',
            error: `Batch must contain at least ${BATCH_MIN_SIZE} leg, got ${legs?.length ?? 0}`,
          },
        ],
      };
    }

    if (legs.length > BATCH_MAX_SIZE) {
      return {
        valid: false,
        errors: [
          {
            legIndex: -1,
            recipient: '',
            amount: '',
            error: `Batch must contain at most ${BATCH_MAX_SIZE} legs, got ${legs.length}`,
          },
        ],
      };
    }

    // Validate each leg
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const legErrors: string[] = [];

      // Validate recipient is non-zero address
      if (!leg.recipient || leg.recipient.trim() === '') {
        legErrors.push('recipient is empty');
      } else if (this.isZeroAddress(leg.recipient)) {
        legErrors.push('recipient is the zero address');
      }

      // Validate amount is a valid positive number in range
      const amount = parseFloat(leg.amount);
      if (!leg.amount || isNaN(amount)) {
        legErrors.push('amount is not a valid number');
      } else if (amount <= 0) {
        legErrors.push('amount must be greater than zero');
      } else if (amount < AMOUNT_MIN) {
        legErrors.push(
          `amount ${amount} is below minimum ${AMOUNT_MIN}`,
        );
      } else if (amount > AMOUNT_MAX) {
        legErrors.push(
          `amount ${amount} exceeds maximum ${AMOUNT_MAX}`,
        );
      }

      if (legErrors.length > 0) {
        errors.push({
          legIndex: i,
          recipient: leg.recipient ?? '',
          amount: leg.amount ?? '',
          error: legErrors.join('; '),
        });
      }
    }

    if (errors.length > 0) {
      this.logger.warn(
        `[batch-validation] Batch rejected: ${errors.length} leg(s) failed validation`,
      );
      return { valid: false, errors };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Executes a cross-currency batch where each leg obtains its own independent
   * RFQ quote and settles independently through the FX flow.
   *
   * If one leg fails, the failure is recorded but other legs continue processing.
   *
   * On batch terminal state, records a batch summary with:
   * - Total legs attempted
   * - Legs succeeded
   * - Legs failed
   * - Total amount disbursed
   * - Batch reference ID
   *
   * @param legs - Array of validated batch legs to execute
   * @param batchReferenceId - Unique identifier linking all legs to the originating batch
   * @returns Batch execution result with per-leg outcomes and summary
   */
  async executeCrossCurrencyBatch(
    legs: BatchLeg[],
    batchReferenceId: string,
  ): Promise<BatchExecutionResult> {
    this.logger.log(
      `[batch-execute] Starting cross-currency batch ${batchReferenceId} with ${legs.length} legs`,
    );

    const legResults: BatchExecutionResult['legResults'] = [];
    let succeeded = 0;
    let failed = 0;
    let totalDisbursed = 0;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const timestamp = new Date().toISOString();

      try {
        // Obtain individual RFQ quote for this leg
        const quote = await this.rfqClient.requestQuote({
          fromCurrency: leg.sourceToken,
          toCurrency: leg.destinationToken,
          fromAmount: leg.amount,
          tenor: 'instant',
        });

        // Create trade against the quote
        const trade = await this.rfqClient.createTrade(
          quote.quoteId,
          `batch-${batchReferenceId}-leg-${i}`,
        );

        // Record success
        const disbursedAmount = parseFloat(quote.toAmount) || 0;
        totalDisbursed += disbursedAmount;
        succeeded++;

        legResults.push({
          legIndex: i,
          recipient: leg.recipient,
          amount: leg.amount,
          success: true,
          quoteId: quote.quoteId,
          tradeId: trade.tradeId,
          timestamp,
        });

        this.logger.log(
          `[batch-execute] Leg ${i} succeeded: quoteId=${quote.quoteId}, tradeId=${trade.tradeId}`,
        );
      } catch (error) {
        // Record failure for this leg, continue processing other legs
        failed++;
        const reason =
          error instanceof Error ? error.message : String(error);

        legResults.push({
          legIndex: i,
          recipient: leg.recipient,
          amount: leg.amount,
          success: false,
          reason,
          timestamp,
        });

        this.logger.warn(
          `[batch-execute] Leg ${i} failed: recipient=${leg.recipient}, amount=${leg.amount}, reason=${reason}`,
        );
      }
    }

    const result: BatchExecutionResult = {
      batchReferenceId,
      totalLegs: legs.length,
      succeeded,
      failed,
      totalDisbursed: totalDisbursed.toFixed(2),
      legResults,
    };

    this.logger.log(
      `[batch-execute] Batch ${batchReferenceId} complete: ` +
        `total=${result.totalLegs}, succeeded=${result.succeeded}, ` +
        `failed=${result.failed}, disbursed=${result.totalDisbursed}`,
    );

    return result;
  }

  /**
   * Checks if an address is the zero address.
   */
  private isZeroAddress(address: string): boolean {
    // Normalize: remove 0x prefix, lowercase, check if all zeros
    const normalized = address.toLowerCase().replace(/^0x/, '');
    return normalized === ZERO_ADDRESS.toLowerCase().replace(/^0x/, '');
  }
}
