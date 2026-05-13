import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StableFXRfqClient, TradeStatus } from './stablefx-rfq-client.service';
import { SettlementValidator } from './settlement-validator.service';
import { FX_POLL_INTERVAL_MS, FX_POLL_MAX_ATTEMPTS } from './fx.constants';
import { ValidationResult } from './fx.types';

/**
 * Job data for StableFX settlement poll jobs on the tx_poll queue.
 */
export interface FxSettlementPollJobData {
  tradeId: string;
  taskId: string;
  minOutput: string;
  quotedAmount: string;
}

/**
 * Interface for the TaskService dependency used by the poller.
 * Decoupled via interface to avoid circular module dependencies.
 */
export interface TaskServicePort {
  updateStatus(
    taskId: string,
    status: string,
    options?: { step?: string; message?: string; result?: Record<string, unknown> },
  ): Promise<unknown>;
  logStep(
    taskId: string,
    step: string,
    status: string,
    message: string,
    options?: { context?: Record<string, unknown> },
  ): Promise<unknown>;
}

/** Trade statuses that indicate successful settlement */
const TERMINAL_SUCCESS_STATUSES = new Set(['completed', 'settled']);

/** Trade statuses that indicate terminal failure */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'expired', 'cancelled']);

/**
 * Error thrown when settlement polling encounters a terminal failure.
 * Re-thrown to BullMQ for retry policy application.
 */
export class SettlementFailedError extends Error {
  constructor(
    public readonly tradeId: string,
    public readonly taskId: string,
    public readonly terminalStatus: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'SettlementFailedError';
  }
}

/**
 * Error thrown when settlement polling exceeds max attempts.
 * Re-thrown to BullMQ for retry policy application.
 */
export class SettlementTimeoutError extends Error {
  constructor(
    public readonly tradeId: string,
    public readonly taskId: string,
    public readonly lastStatus: string,
    public readonly totalAttempts: number,
  ) {
    super(
      `Settlement poll timeout for trade ${tradeId}: ${totalAttempts} attempts exhausted, last status="${lastStatus}"`,
    );
    this.name = 'SettlementTimeoutError';
  }
}

/**
 * SettlementPollerService polls Circle StableFX trade status and finalizes
 * FX settlement tasks.
 *
 * Responsibilities:
 * - Poll Circle StableFX API via StableFXRfqClient.getTradeStatus() at configurable intervals
 * - Track poll attempts with configurable max (default 60)
 * - Log status transitions as task steps for audit
 * - On terminal success (completed/settled): validate output via SettlementValidator,
 *   update task to EXECUTED if valid, FAILED if rejected
 * - On terminal failure (failed/expired/cancelled): mark task FAILED, re-throw for BullMQ retry
 * - On timeout: mark task FAILED with timeout reason, re-throw for BullMQ retry
 * - Registered as BullMQ processor on the `tx_poll` queue
 *
 * Requirements: 3.2, 3.3, 3.4, 3.7, 5.5, 5.7
 */
@Injectable()
export class SettlementPollerService {
  private readonly logger = new Logger(SettlementPollerService.name);
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly rfqClient: StableFXRfqClient,
    private readonly settlementValidator: SettlementValidator,
    private readonly configService: ConfigService,
  ) {
    this.pollIntervalMs =
      this.configService.get<number>('FX_POLL_INTERVAL_MS') ?? FX_POLL_INTERVAL_MS;
    this.maxAttempts =
      this.configService.get<number>('FX_POLL_MAX_ATTEMPTS') ?? FX_POLL_MAX_ATTEMPTS;
  }

  /**
   * Polls the Circle StableFX trade status until a terminal state is reached
   * or max attempts are exhausted.
   *
   * This method is designed to be called by a BullMQ processor on the `tx_poll` queue.
   * It blocks for the duration of polling (up to maxAttempts × pollIntervalMs).
   *
   * @param tradeId - The Circle StableFX trade identifier
   * @param taskId - The internal task identifier for logging and status updates
   * @param taskService - TaskService port for status updates and logging
   * @param minOutput - Minimum acceptable output amount
   * @param quotedAmount - Originally quoted output amount
   *
   * @throws SettlementFailedError on terminal failure status (re-throw to BullMQ)
   * @throws SettlementTimeoutError on max attempts exceeded (re-throw to BullMQ)
   */
  async pollTradeStatus(
    tradeId: string,
    taskId: string,
    taskService: TaskServicePort,
    minOutput: string,
    quotedAmount: string,
  ): Promise<void> {
    let previousStatus: string | undefined;
    let lastStatus = 'unknown';
    let attempt = 0;

    this.logger.log(
      `Starting settlement poll — tradeId=${tradeId} taskId=${taskId} ` +
        `maxAttempts=${this.maxAttempts} intervalMs=${this.pollIntervalMs}`,
    );

    while (attempt < this.maxAttempts) {
      attempt++;

      // Poll Circle StableFX API
      const tradeStatus: TradeStatus = await this.rfqClient.getTradeStatus(tradeId);
      const currentStatus = tradeStatus.status;
      lastStatus = currentStatus;

      // Log status transition as task step
      if (currentStatus !== previousStatus) {
        const transitionMessage = previousStatus
          ? `Trade ${tradeId} status: ${previousStatus} → ${currentStatus} (attempt ${attempt}/${this.maxAttempts})`
          : `Trade ${tradeId} initial status: ${currentStatus} (attempt ${attempt}/${this.maxAttempts})`;

        await taskService.logStep(
          taskId,
          'fx.settlement_polling',
          'in_progress',
          transitionMessage,
          {
            context: {
              tradeId,
              attempt,
              previousStatus: previousStatus ?? null,
              currentStatus,
              maxAttempts: this.maxAttempts,
            },
          },
        );

        this.logger.log(transitionMessage);
        previousStatus = currentStatus;
      }

      // ── Terminal success ──────────────────────────────────────────
      if (TERMINAL_SUCCESS_STATUSES.has(currentStatus)) {
        await this.handleTerminalSuccess(
          tradeId,
          taskId,
          tradeStatus,
          taskService,
          minOutput,
          quotedAmount,
          attempt,
        );
        return;
      }

      // ── Terminal failure ──────────────────────────────────────────
      if (TERMINAL_FAILURE_STATUSES.has(currentStatus)) {
        await this.handleTerminalFailure(
          tradeId,
          taskId,
          currentStatus,
          taskService,
          attempt,
        );
        // Does not return — throws
      }

      // ── Non-terminal: wait and poll again ────────────────────────
      await this.sleep(this.pollIntervalMs);
    }

    // ── Timeout: max attempts exceeded ─────────────────────────────
    await this.handleTimeout(tradeId, taskId, lastStatus, attempt, taskService);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Terminal Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleTerminalSuccess(
    tradeId: string,
    taskId: string,
    tradeStatus: TradeStatus,
    taskService: TaskServicePort,
    minOutput: string,
    quotedAmount: string,
    attempt: number,
  ): Promise<void> {
    const settledAmount = tradeStatus.toAmount;

    this.logger.log(
      `Trade ${tradeId} settled successfully — status=${tradeStatus.status} ` +
        `settledAmount=${settledAmount} attempt=${attempt}`,
    );

    // Validate settlement output via SettlementValidator
    const validationResult: ValidationResult = this.settlementValidator.validateOutput({
      settledAmount,
      minAcceptableOutput: minOutput,
      quotedAmount,
      tolerancePercent: 1,
    });

    if (validationResult.accepted) {
      // Settlement accepted — mark task EXECUTED
      await taskService.logStep(
        taskId,
        'fx.settlement_confirmed',
        'executed',
        `Settlement confirmed: trade ${tradeId} settled ${settledAmount}`,
        {
          context: {
            tradeId,
            settledAmount,
            quotedAmount,
            deviationPercent: validationResult.deviationPercent,
            alertRequired: validationResult.alertRequired,
            attempt,
          },
        },
      );

      await taskService.updateStatus(taskId, 'executed', {
        step: 'fx.settlement_confirmed',
        message: `FX settlement confirmed: ${settledAmount} received`,
        result: {
          tradeId,
          settledAmount,
          quotedAmount,
          deviationPercent: validationResult.deviationPercent,
          alertRequired: validationResult.alertRequired ?? false,
        },
      });
    } else {
      // Settlement rejected by validator — mark task FAILED
      const reason =
        validationResult.reason ??
        `Settlement output ${settledAmount} below minimum ${minOutput}`;

      await taskService.logStep(
        taskId,
        'fx.output_validation_failed',
        'failed',
        `Settlement validation failed: ${reason}`,
        {
          context: {
            tradeId,
            settledAmount,
            minOutput,
            quotedAmount,
            deviationPercent: validationResult.deviationPercent,
            reason,
          },
        },
      );

      await taskService.updateStatus(taskId, 'failed', {
        step: 'fx.output_validation_failed',
        message: reason,
        result: {
          tradeId,
          settledAmount,
          minOutput,
          quotedAmount,
          deviationPercent: validationResult.deviationPercent,
          reason,
        },
      });
    }
  }

  private async handleTerminalFailure(
    tradeId: string,
    taskId: string,
    terminalStatus: string,
    taskService: TaskServicePort,
    attempt: number,
  ): Promise<never> {
    const reason = `Trade ${tradeId} reached terminal failure status: ${terminalStatus} after ${attempt} poll attempts`;

    this.logger.error(reason);

    await taskService.logStep(
      taskId,
      'fx.settlement_failed',
      'failed',
      reason,
      {
        context: {
          tradeId,
          terminalStatus,
          attempt,
        },
      },
    );

    await taskService.updateStatus(taskId, 'failed', {
      step: 'fx.settlement_failed',
      message: reason,
      result: {
        tradeId,
        terminalStatus,
        attempt,
      },
    });

    throw new SettlementFailedError(tradeId, taskId, terminalStatus, reason);
  }

  private async handleTimeout(
    tradeId: string,
    taskId: string,
    lastStatus: string,
    totalAttempts: number,
    taskService: TaskServicePort,
  ): Promise<never> {
    const reason =
      `Settlement poll timeout for trade ${tradeId}: ` +
      `${totalAttempts} attempts exhausted (max=${this.maxAttempts}), ` +
      `last status="${lastStatus}"`;

    this.logger.error(reason);

    await taskService.logStep(
      taskId,
      'fx.settlement_failed',
      'failed',
      reason,
      {
        context: {
          tradeId,
          lastStatus,
          totalAttempts,
          maxAttempts: this.maxAttempts,
          totalTimeMs: totalAttempts * this.pollIntervalMs,
        },
      },
    );

    await taskService.updateStatus(taskId, 'failed', {
      step: 'fx.settlement_failed',
      message: reason,
      result: {
        tradeId,
        lastStatus,
        totalAttempts,
        maxAttempts: this.maxAttempts,
        timeoutReason: 'max_attempts_exceeded',
      },
    });

    throw new SettlementTimeoutError(tradeId, taskId, lastStatus, totalAttempts);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
