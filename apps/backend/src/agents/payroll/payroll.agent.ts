import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { CircleService } from '../../adapters/circle.service';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { TaskDetails, TaskPayload } from '../../task/task.types';
import { AgentExecutionResult, TaskAgent } from '../agent.interface';
import { PayrollValidationService } from './payroll-validation.service';
import {
  PayrollBatchService,
  PayrollBatch,
} from './payroll-batch.service';
import { QueueService } from '../../queue/queue.service';

// ─── Types ──────────────────────────────────────────────────────────

interface SubmissionRecord {
  recipient: string;
  amount: string;
  currency: string;
  txId: string;
  batchIndex: number;
  status: 'submitted' | 'submit_failed';
  errorReason: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Submit sequentially to avoid Circle API rate-limit bursts on large payroll batches. */
const SUBMISSION_CONCURRENCY = 1;

/** Retry transient Circle rate-limit failures with a short linear backoff. */
const SUBMISSION_RATE_LIMIT_MAX_RETRIES = 3;
const SUBMISSION_RATE_LIMIT_RETRY_DELAY_MS = 1500;

// ─── Agent ──────────────────────────────────────────────────────────

/**
 * PayrollAgent — NON-BLOCKING payroll execution.
 *
 * This agent is now a FAST submission dispatcher. It:
 *   1. Validates recipients
 *   2. Batches them
 *   3. Submits transfers to Circle (concurrently, up to 5 at a time)
 *   4. Persists each transaction in the database (status: pending)
 *   5. Enqueues a poll job for each transaction
 *   6. Returns IMMEDIATELY — does NOT wait for confirmations
 *
 * Transaction confirmation is handled by TransactionPollerService
 * running on the separate TX_POLL queue.
 *
 * When all transactions reach a terminal state, the poller finalizes
 * the task status (executed / partial / failed).
 *
 * Status management:
 * - Agent does NOT set final task status (executed/failed/partial)
 * - Agent only moves task to in_progress and logs submissions
 * - Final status is set by TransactionPollerService after all txs resolve
 */
@Injectable()
export class PayrollAgent implements TaskAgent {
  private readonly logger = new Logger(PayrollAgent.name);

  constructor(
    private readonly circleService: CircleService,
    private readonly taskService: TaskService,
    private readonly validationService: PayrollValidationService,
    private readonly batchService: PayrollBatchService,
    private readonly queueService: QueueService,
  ) {}

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    this.logger.log(`Payroll agent executing — taskId=${task.id}`);

    // ── Idempotency: skip if task already has submissions ──────────
    if (task.result && typeof task.result === 'object' && 'agent' in task.result) {
      this.logger.warn(
        `Payroll task ${task.id} already has a result — returning existing (idempotent)`,
      );
      return task.result as AgentExecutionResult;
    }

    // ── Step 1: Validate ───────────────────────────────────────────
    const validation = await this.validationService.validate(task.payload);

    if (!validation.valid) {
      const errorMessages = validation.errors.join('; ');
      this.logger.warn(
        `Validation failed — taskId=${task.id} errors="${errorMessages}"`,
      );
      throw new BadRequestException(
        `Payroll validation failed: ${errorMessages}`,
      );
    }

    await this.taskService.logStep(
      task.id,
      'payroll.validated',
      TaskStatus.IN_PROGRESS,
      `Validated ${validation.recipients.length} recipients`,
    );

    // ── Step 2: Batch ─────────────────────────────────────────────
    const batches = this.batchService.splitIntoBatches(validation.recipients);
    const totals = this.batchService.calculateTotals(batches);
    const sourceToken = (task.payload.sourceToken as string) ?? 'USDC';
    const network =
      typeof task.payload.network === 'string' ? task.payload.network : undefined;

    await this.taskService.logStep(
      task.id,
      'payroll.batched',
      TaskStatus.IN_PROGRESS,
      `Split into ${totals.totalBatches} batch(es) — ${totals.totalRecipients} recipients`,
    );

    this.logger.log(
      `Payroll batched — taskId=${task.id} batches=${totals.totalBatches} recipients=${totals.totalRecipients}`,
    );

    // ── Step 3: Submit all transfers (non-blocking) ───────────────
    const submissions: SubmissionRecord[] = [];

    for (const batch of batches) {
      const batchSubmissions = await this.submitBatchConcurrently(
        task.id,
        batch,
        network,
      );
      submissions.push(...batchSubmissions);

      await this.taskService.logStep(
        task.id,
        `payroll.batch.${batch.index}.submitted`,
        TaskStatus.IN_PROGRESS,
        `Batch ${batch.index + 1}: ${batchSubmissions.filter((s) => s.status === 'submitted').length}/${batch.recipients.length} transfers submitted`,
      );
    }

    // ── Step 4: Build submission result ────────────────────────────
    const submitted = submissions.filter((s) => s.status === 'submitted');
    const submitFailed = submissions.filter((s) => s.status === 'submit_failed');

    if (submitted.length === 0 && submitFailed.length > 0) {
      throw new Error(
        `All ${submitFailed.length} transfer submissions failed. First error: ${submitFailed[0].errorReason ?? 'Unknown'}`,
      );
    }

    const result: AgentExecutionResult = {
      agent: 'payroll',
      sourceToken,
      totalBatches: totals.totalBatches,
      totalRecipients: totals.totalRecipients,
      submitted: submitted.length,
      submitFailed: submitFailed.length,
      // Final counts (completed/failed) will be filled by TransactionPollerService
      // when all transactions reach terminal state
      awaitingConfirmation: submitted.length,
      submissions: submissions.map((s) => ({
        recipient: s.recipient,
        amount: s.amount,
        currency: s.currency,
        txId: s.txId,
        batchIndex: s.batchIndex,
        status: s.status,
      })),
      ...(submitFailed.length > 0
        ? {
            submissionFailures: submitFailed.map((f) => ({
              recipient: f.recipient,
              reason: f.errorReason ?? 'Unknown',
            })),
          }
        : {}),
    };

    this.logger.log(
      `Payroll agent done (non-blocking) — taskId=${task.id} submitted=${submitted.length} submitFailed=${submitFailed.length}`,
    );

    return result;
  }

  // ════════════════════════════════════════════════════════════════════
  //  Concurrent batch submission
  // ════════════════════════════════════════════════════════════════════

  /**
   * Submit all transfers in a batch with limited concurrency.
   *
   * Uses a simple concurrency pool: up to SUBMISSION_CONCURRENCY
   * transfers are in-flight at any time.
   *
   * Does NOT wait for Circle transaction confirmation — only submission.
   */
  private async submitBatchConcurrently(
    taskId: string,
    batch: PayrollBatch,
    network?: string,
  ): Promise<SubmissionRecord[]> {
    const results: SubmissionRecord[] = [];
    const inFlight: Promise<void>[] = [];

    for (let i = 0; i < batch.recipients.length; i++) {
      const recipient = batch.recipients[i];
      const submissionKey = `${taskId}-b${batch.index}-r${i}`;
      const transferIdempotencyKey = this.buildTransferIdempotencyKey(
        taskId,
        batch.index,
        i,
      );

      const work = (async () => {
        const record = await this.submitSingleTransfer(
          taskId,
          recipient,
          batch.index,
          submissionKey,
          transferIdempotencyKey,
          network,
        );
        results.push(record);
      })();

      inFlight.push(work);

      // Enforce concurrency limit
      if (inFlight.length >= SUBMISSION_CONCURRENCY) {
        await Promise.race(inFlight);
        // Remove settled promises
        for (let j = inFlight.length - 1; j >= 0; j--) {
          const settled = await Promise.race([
            inFlight[j].then(() => true),
            Promise.resolve(false),
          ]);
          if (settled) {
            inFlight.splice(j, 1);
          }
        }
      }
    }

    // Wait for remaining in-flight submissions
    await Promise.allSettled(inFlight);

    return results;
  }

  /**
   * Submit a single transfer to Circle + persist + enqueue poll.
   *
   * This is the core non-blocking unit of work:
   *   1. Call CircleService.transfer() — fast, returns txId immediately
   *   2. Persist the transaction in DB (status: pending)
   *   3. Enqueue a poll job on the TX_POLL queue
   *   4. Return immediately
   */
  private async submitSingleTransfer(
    taskId: string,
    recipient: {
      address: string;
      amount: string;
      targetToken: string;
      amountUnits: bigint;
    },
    batchIndex: number,
    submissionKey: string,
    transferIdempotencyKey: string,
    network?: string,
  ): Promise<SubmissionRecord> {
    try {
      let transferResult: Awaited<ReturnType<CircleService['transfer']>> | null = null;

      for (let retryAttempt = 0; retryAttempt <= SUBMISSION_RATE_LIMIT_MAX_RETRIES; retryAttempt++) {
        try {
          transferResult = await this.circleService.transfer({
            toAddress: recipient.address,
            amount: recipient.amount,
            token: recipient.targetToken,
            network,
            idempotencyKey: transferIdempotencyKey,
          });
          break;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown submission error';

          if (
            !this.isRateLimitError(errorMessage) ||
            retryAttempt >= SUBMISSION_RATE_LIMIT_MAX_RETRIES
          ) {
            throw error;
          }

          const retryDelayMs =
            SUBMISSION_RATE_LIMIT_RETRY_DELAY_MS * (retryAttempt + 1);

          this.logger.warn(
            `Circle rate limit on transfer submission — taskId=${taskId} to=${recipient.address} retry=${retryAttempt + 1}/${SUBMISSION_RATE_LIMIT_MAX_RETRIES} waitMs=${retryDelayMs}`,
          );

          await this.delay(retryDelayMs);
        }
      }

      if (!transferResult) {
        throw new Error('Circle transfer submission did not return a result.');
      }

      // ── Persist transaction in DB ─────────────────────────────────
      await this.taskService.appendTransaction({
        taskId,
        txId: transferResult.txId,
        recipient: recipient.address,
        amount: recipient.amount,
        currency: recipient.targetToken,
        batchIndex,
      });

      // ── Enqueue poll job (non-blocking) ────────────────────────────
      await this.queueService.enqueueTransactionPoll(
        {
          taskId,
          txId: transferResult.txId,
          attempt: 0,
        },
        2000, // initial poll delay
      );

      // ── Log submission ─────────────────────────────────────────────
      await this.taskService.logStep(
        taskId,
        'tx.submitted',
        TaskStatus.IN_PROGRESS,
        `Transfer submitted: ${recipient.amount} ${recipient.targetToken} → ${recipient.address} — txId=${transferResult.txId}`,
      );

      this.logger.log(
        `Transfer submitted — taskId=${taskId} to=${recipient.address} txId=${transferResult.txId}`,
      );

      return {
        recipient: recipient.address,
        amount: recipient.amount,
        currency: recipient.targetToken,
        txId: transferResult.txId,
        batchIndex,
        status: 'submitted',
        errorReason: null,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown submission error';

      this.logger.error(
        `Transfer submission failed — taskId=${taskId} to=${recipient.address} error="${errorMessage}"`,
      );

      await this.taskService.logStep(
        taskId,
        'tx.submit_failed',
        TaskStatus.IN_PROGRESS,
        `Transfer submission failed: ${recipient.amount} ${recipient.targetToken} → ${recipient.address} — ${errorMessage}`,
      );

      // Persist the failed submission so the poller can still aggregate
      await this.taskService.appendTransaction({
        taskId,
        txId: `failed_${submissionKey}`,
        recipient: recipient.address,
        amount: recipient.amount,
        currency: recipient.targetToken,
        batchIndex,
      });

      // Immediately mark it as failed (no need to poll)
      await this.taskService.updateTransaction(
        `failed_${submissionKey}`,
        {
          status: 'failed',
          errorReason: errorMessage,
        },
      );

      return {
        recipient: recipient.address,
        amount: recipient.amount,
        currency: recipient.targetToken,
        txId: `failed_${submissionKey}`,
        batchIndex,
        status: 'submit_failed',
        errorReason: errorMessage,
      };
    }
  }

  private isRateLimitError(message: string): boolean {
    const normalizedMessage = message.toLowerCase();
    return (
      normalizedMessage.includes('rate limit') ||
      normalizedMessage.includes('too many requests') ||
      normalizedMessage.includes('429')
    );
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildTransferIdempotencyKey(
    taskId: string,
    batchIndex: number,
    recipientIndex: number,
  ): string {
    const digest = createHash('sha256')
      .update(`${taskId}:${batchIndex}:${recipientIndex}`)
      .digest('hex');
    const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);

    return [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `${variant}${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join('-');
  }
}