import { Injectable, Logger } from '@nestjs/common';
import { BlockchainService } from '../../adapters/blockchain.service';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { QueueService } from '../../queue/queue.service';
import { TxPollJobData } from '../../queue/queue.types';

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum number of poll attempts per transaction (≈6 minutes at 2s intervals) */
const MAX_POLL_ATTEMPTS = 180;

/** Delay between poll re-enqueues (ms) */
const POLL_DELAY_MS = 2000;

/** Receipt status value that indicates on-chain success */
const RECEIPT_SUCCESS_STATUS = '0x1';

// ─── Service ────────────────────────────────────────────────────────

/**
 * TransactionPollerService handles non-blocking transaction status polling
 * on Arc Mainnet.
 *
 * Architecture:
 *   External wallet submits transfer → poll job enqueued → returns immediately
 *   TransactionPollerWorker picks up poll job → calls this service
 *   This service reads the Mainnet receipt → updates DB → re-enqueues or finalizes
 *
 * For each poll:
 *   1. Read the receipt via BlockchainService.getTransactionReceiptOnChain(txHash, 'ARC-MAINNET')
 *   2. If receipt present with success status:
 *      a. Update TaskTransaction record to completed
 *      b. Check if ALL task transactions are terminal
 *      c. If yes → finalize task status (executed/partial/failed)
 *   3. If receipt present with failure status → mark failed, finalize check
 *   4. If no receipt yet:
 *      a. Increment attempt counter
 *      b. Re-enqueue with delay
 *      c. If max attempts reached → mark as failed (timeout)
 */
@Injectable()
export class TransactionPollerService {
  private readonly logger = new Logger(TransactionPollerService.name);

  constructor(
    private readonly blockchainService: BlockchainService,
    private readonly taskService: TaskService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * Process a single transaction poll job.
   *
   * Called by TxPollProcessor for each job on the TX_POLL queue.
   */
  async poll(jobData: TxPollJobData): Promise<void> {
    const { network, taskId, txId, attempt } = jobData;

    this.logger.debug(
      `Polling tx — taskId=${taskId} txId=${txId} attempt=${attempt}/${MAX_POLL_ATTEMPTS}`,
    );

    // ── Mainnet isolation ──────────────────────────────────────────
    if (network !== 'arc-mainnet') {
      await this.failVerification(
        taskId,
        txId,
        attempt,
        `Transaction polling supports Arc Mainnet only (got network="${network}").`,
      );
      return;
    }

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

    // ── Read Mainnet receipt ───────────────────────────────────────
    let receipt: Awaited<
      ReturnType<BlockchainService['getTransactionReceiptOnChain']>
    >;
    try {
      receipt = await this.blockchainService.getTransactionReceiptOnChain(
        txId,
        'ARC-MAINNET',
      );
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

    // ── No receipt yet: re-enqueue ─────────────────────────────────
    if (!receipt) {
      this.logger.debug(
        `TX still pending — taskId=${taskId} txId=${txId} attempt=${attempt} — re-enqueuing`,
      );

      await this.taskService.updateTransaction(txId, {
        status: 'pending',
        pollAttempts: attempt + 1,
      });

      await this.queueService.enqueueTransactionPoll(
        { network, taskId, txId, attempt: attempt + 1 },
        POLL_DELAY_MS,
      );
      return;
    }

    // ── Receipt present ────────────────────────────────────────────
    if (receipt.status === RECEIPT_SUCCESS_STATUS) {
      await this.taskService.updateTransaction(txId, {
        status: 'completed',
        txHash: receipt.transactionHash,
        pollAttempts: attempt + 1,
      });

      await this.taskService.logStep(
        taskId,
        'tx.completed',
        TaskStatus.IN_PROGRESS,
        `Transaction confirmed: txId=${txId} txHash=${receipt.transactionHash}`,
      );

      this.logger.log(
        `TX completed — taskId=${taskId} txId=${txId} txHash=${receipt.transactionHash}`,
      );
    } else {
      const reason = `Mainnet transaction ended with receipt status: ${receipt.status}`;

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
        `TX failed — taskId=${taskId} txId=${txId} status=${receipt.status} reason="${reason}"`,
      );
    }

    // Check if all transactions for this task are now terminal
    await this.checkAndFinalizeTask(taskId);
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
