import { Injectable, Logger } from '@nestjs/common';
import { CircleService } from '../../adapters/circle.service';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { QueueService } from '../../queue/queue.service';
import { TxPollJobData } from '../../queue/queue.types';
import { ConfigService } from '@nestjs/config';
import { getAddress, parseUnits } from 'viem';
import { CircleReceiptVerifierService } from '../../adapters/circle/circle-receipt-verifier.service';
import type { BackendArcNetworkConfiguration } from '../../config/arc-network.config';

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum number of poll attempts per transaction (≈6 minutes at 2s intervals) */
const MAX_POLL_ATTEMPTS = 180;

/** Delay between poll re-enqueues (ms) */
const POLL_DELAY_MS = 2000;

/** Circle transaction states that are terminal */
const TERMINAL_STATUSES = new Set([
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'DENIED',
]);

/** Circle transaction states that indicate failure */
const FAILURE_STATUSES = new Set(['FAILED', 'CANCELLED', 'DENIED']);

// ─── Service ────────────────────────────────────────────────────────

/**
 * TransactionPollerService handles non-blocking transaction status polling.
 *
 * Architecture:
 *   PayrollAgent submits transfer → enqueues poll job → returns immediately
 *   TransactionPollerWorker picks up poll job → calls this service
 *   This service polls Circle → updates DB → re-enqueues or finalizes
 *
 * For each poll:
 *   1. Call CircleService.getTransactionStatus(txId)
 *   2. If terminal (COMPLETE/FAILED):
 *      a. Update TaskTransaction record
 *      b. Check if ALL task transactions are terminal
 *      c. If yes → finalize task status (executed/partial/failed)
 *   3. If non-terminal:
 *      a. Increment attempt counter
 *      b. Re-enqueue with delay
 *      c. If max attempts reached → mark as failed (timeout)
 */
@Injectable()
export class TransactionPollerService {
  private readonly logger = new Logger(TransactionPollerService.name);

  constructor(
    private readonly circleService: CircleService,
    private readonly taskService: TaskService,
    private readonly queueService: QueueService,
    private readonly receiptVerifier: CircleReceiptVerifierService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Process a single transaction poll job.
   *
   * Called by TransactionPollerProcessor for each job on the TX_POLL queue.
   */
  async poll(jobData: TxPollJobData): Promise<void> {
    const { network, taskId, txId, attempt } = jobData;

    this.logger.debug(
      `Polling tx — taskId=${taskId} txId=${txId} attempt=${attempt}/${MAX_POLL_ATTEMPTS}`,
    );

    // ── Check max attempts ─────────────────────────────────────────
    if (attempt >= MAX_POLL_ATTEMPTS) {
      this.logger.error(
        `TX poll timeout — taskId=${taskId} txId=${txId} after ${attempt} attempts`,
      );

      await this.taskService.updateTransaction(txId, {
        status: 'failed',
        errorReason: `Transaction did not reach terminal state within ${MAX_POLL_ATTEMPTS} poll attempts (${(MAX_POLL_ATTEMPTS * POLL_DELAY_MS) / 1000}s)`,
        pollAttempts: attempt,
      });

      await this.taskService.logStep(
        taskId,
        'tx.timeout',
        TaskStatus.IN_PROGRESS,
        `Transaction ${txId} timed out after ${attempt} poll attempts`,
      );

      await this.checkAndFinalizeTask(taskId);
      return;
    }

    // ── Poll Circle ────────────────────────────────────────────────
    let circleStatus;
    try {
      circleStatus = await this.circleService.getTransactionStatus(txId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown polling error';

      this.logger.warn(
        `TX poll error (transient) — taskId=${taskId} txId=${txId} attempt=${attempt} error="${message}"`,
      );

      // Transient error — re-enqueue with incremented attempt
      await this.queueService.enqueueTransactionPoll(
        { network, taskId, txId, attempt: attempt + 1 },
        POLL_DELAY_MS,
      );

      await this.taskService.updateTransaction(txId, {
        status: 'pending',
        pollAttempts: attempt + 1,
      });

      return;
    }

    // ── Handle terminal status ─────────────────────────────────────
    if (TERMINAL_STATUSES.has(circleStatus.status)) {
      if (FAILURE_STATUSES.has(circleStatus.status)) {
        // Transaction failed
        const reason =
          circleStatus.errorReason ??
          `Circle transaction ended with status: ${circleStatus.status}`;

        await this.taskService.updateTransaction(txId, {
          status: 'failed',
          errorReason: reason,
          pollAttempts: attempt + 1,
        });

        await this.taskService.logStep(
          taskId,
          'tx.failed',
          TaskStatus.IN_PROGRESS,
          `Transaction failed: txId=${txId} — ${reason}`,
        );

        this.logger.warn(
          `TX failed — taskId=${taskId} txId=${txId} status=${circleStatus.status} reason="${reason}"`,
        );
      } else {
        const trackedTransactions =
          await this.taskService.getTaskTransactions(taskId);
        const tracked = trackedTransactions.find(
          (transaction) => transaction.txId === txId,
        );
        if (!tracked || !circleStatus.txHash) {
          await this.requeueUnverified(jobData);
          return;
        }
        const arcNetwork =
          this.config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
        const token =
          arcNetwork.tokens[tracked.currency as keyof typeof arcNetwork.tokens];
        if (!token) {
          await this.failVerification(
            taskId,
            txId,
            attempt,
            'Tracked Circle transaction token is unavailable.',
          );
          return;
        }
        try {
          await this.receiptVerifier.verifyTransfer({
            transactionHash: circleStatus.txHash as `0x${string}`,
            senderAddress: circleStatus.sourceAddress
              ? getAddress(circleStatus.sourceAddress)
              : null,
            recipientAddress: getAddress(tracked.recipient),
            tokenAddress: getAddress(token.address),
            amountUnits: parseUnits(tracked.amount, token.decimals),
            circleBlockchain: circleStatus.blockchain,
          });
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'retryable' in error &&
            error.retryable === true
          ) {
            await this.requeueUnverified(jobData);
          } else {
            await this.failVerification(
              taskId,
              txId,
              attempt,
              'Circle transaction receipt verification failed.',
            );
          }
          return;
        }
        // Circle COMPLETE is accepted only after selected-network receipt proof.
        await this.taskService.updateTransaction(txId, {
          status: 'completed',
          txHash: circleStatus.txHash,
          pollAttempts: attempt + 1,
        });

        await this.taskService.logStep(
          taskId,
          'tx.completed',
          TaskStatus.IN_PROGRESS,
          `Transaction confirmed: txId=${txId} txHash=${circleStatus.txHash}`,
        );

        this.logger.log(
          `TX completed — taskId=${taskId} txId=${txId} txHash=${circleStatus.txHash}`,
        );
      }

      // Check if all transactions for this task are now terminal
      await this.checkAndFinalizeTask(taskId);
      return;
    }

    // ── Non-terminal: re-enqueue ───────────────────────────────────
    this.logger.debug(
      `TX still pending — taskId=${taskId} txId=${txId} circleStatus=${circleStatus.status} — re-enqueuing`,
    );

    await this.taskService.updateTransaction(txId, {
      status: 'pending',
      pollAttempts: attempt + 1,
    });

    await this.queueService.enqueueTransactionPoll(
      { network, taskId, txId, attempt: attempt + 1 },
      POLL_DELAY_MS,
    );
  }

  private async requeueUnverified(jobData: TxPollJobData): Promise<void> {
    await this.taskService.updateTransaction(jobData.txId, {
      status: 'pending',
      pollAttempts: jobData.attempt + 1,
    });
    await this.queueService.enqueueTransactionPoll(
      { ...jobData, attempt: jobData.attempt + 1 },
      POLL_DELAY_MS,
    );
  }

  private async failVerification(
    taskId: string,
    txId: string,
    attempt: number,
    errorReason: string,
  ): Promise<void> {
    await this.taskService.updateTransaction(txId, {
      status: 'failed',
      errorReason,
      pollAttempts: attempt + 1,
    });
    await this.taskService.logStep(
      taskId,
      'tx.receipt_verification_failed',
      TaskStatus.IN_PROGRESS,
      errorReason,
    );
    await this.checkAndFinalizeTask(taskId);
  }

  // ════════════════════════════════════════════════════════════════════
  //  Task finalization
  // ════════════════════════════════════════════════════════════════════

  /**
   * Check if all transactions for a task have reached terminal status.
   * If yes, finalize the task with the appropriate status:
   *   - All completed → EXECUTED
   *   - All failed → FAILED
   *   - Mixed → PARTIAL
   */
  private async checkAndFinalizeTask(taskId: string): Promise<void> {
    const submissionsComplete = await this.taskService.hasLogStep(
      taskId,
      'task.submissions_complete',
    );

    if (!submissionsComplete) {
      this.logger.debug(
        `Task ${taskId} still receiving submissions — skipping finalization until task.submissions_complete is logged`,
      );
      return;
    }

    const aggregation =
      await this.taskService.getTransactionAggregation(taskId);

    if (!aggregation.allTerminal) {
      this.logger.debug(
        `Task ${taskId} not yet finalized — pending=${aggregation.pending} completed=${aggregation.completed} failed=${aggregation.failed}`,
      );
      return;
    }

    // All transactions are terminal — determine final task status
    const { total, completed, failed, txHashes } = aggregation;

    const result = {
      agent: 'payroll',
      total,
      completed,
      failed,
      txHashes,
    };

    if (failed === 0) {
      // All succeeded
      await this.taskService.updateStatus(taskId, TaskStatus.EXECUTED, {
        step: 'task.executed',
        message: `All ${total} transfers completed successfully`,
        result,
      });

      this.logger.log(
        `Task finalized — taskId=${taskId} status=EXECUTED completed=${completed}`,
      );
    } else if (completed === 0) {
      // All failed
      await this.taskService.updateStatus(taskId, TaskStatus.FAILED, {
        step: 'task.failed',
        message: `All ${total} transfers failed`,
        result,
      });

      this.logger.log(
        `Task finalized — taskId=${taskId} status=FAILED failed=${failed}`,
      );
    } else {
      // Mixed results
      await this.taskService.updateStatus(taskId, TaskStatus.PARTIAL, {
        step: 'task.partial',
        message: `${completed}/${total} transfers completed, ${failed} failed`,
        result,
      });

      this.logger.log(
        `Task finalized — taskId=${taskId} status=PARTIAL completed=${completed} failed=${failed}`,
      );
    }
  }
}
