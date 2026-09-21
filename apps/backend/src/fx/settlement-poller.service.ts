import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettlementValidator } from './settlement-validator.service';
import { FX_POLL_INTERVAL_MS, FX_POLL_MAX_ATTEMPTS } from './fx.constants';
import { ValidationResult } from './fx.types';

/**
 * Job data for settlement poll jobs on the tx_poll queue.
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
 * Re-thrown for retry policy application.
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
 * Re-thrown for retry policy application.
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

export interface SettlementTradeStatus {
  tradeId: string;
  status: string;
  fromAmount: string;
  toAmount: string;
}

/**
 * SettlementPollerService finalizes FX settlement tasks on Arc Mainnet.
 *
 * Backend provider polling is retired: there is no backend settlement
 * provider to poll. Settlement evidence comes from Mainnet receipts
 * verified against the external-wallet execution plan.
 *
 * Responsibilities:
 * - Track poll attempts with configurable max (default 60)
 * - On terminal success (completed/settled): validate output via SettlementValidator,
 *   update task to EXECUTED if valid, FAILED if rejected
 * - On terminal failure (failed/expired/cancelled): mark task FAILED
 * - On timeout: mark task FAILED with timeout reason
 */
@Injectable()
export class SettlementPollerService {
  private readonly logger = new Logger(SettlementPollerService.name);
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly settlementValidator: SettlementValidator,
    private readonly configService: ConfigService,
  ) {
    this.pollIntervalMs =
      this.configService.get<number>('FX_POLL_INTERVAL_MS') ?? FX_POLL_INTERVAL_MS;
    this.maxAttempts =
      this.configService.get<number>('FX_POLL_MAX_ATTEMPTS') ?? FX_POLL_MAX_ATTEMPTS;
  }

  /**
   * Polls trade status until a terminal state is reached
   * or max attempts are exhausted.
   *
   * The status provider resolves terminal trade state from Mainnet
   * settlement evidence. When no provider is configured the poll fails
   * closed without marking the task.
   *
   * @param tradeId - The trade identifier
   * @param taskId - The internal task identifier for logging and status updates
   * @param taskService - TaskService port for status updates and logging
   * @param minOutput - Minimum acceptable output amount
   * @param quotedAmount - Originally quoted output amount
   * @param getTradeStatus - Optional status provider; required for polling
   *
   * @throws SettlementFailedError on terminal failure status
   * @throws SettlementTimeoutError on max attempts exceeded
   * @throws ServiceUnavailableException when no status provider is configured
   */
  async pollTradeStatus(
    tradeId: string,
    taskId: string,
    taskService: TaskServicePort,
    minOutput: string,
    quotedAmount: string,
    getTradeStatus?: (tradeId: string) => Promise<SettlementTradeStatus>,
  ): Promise<void> {
    if (!getTradeStatus) {
      throw new ServiceUnavailableException({
        code: 'SETTLEMENT_POLL_UNAVAILABLE',
        message:
          'Settlement polling is unavailable: no Mainnet status provider is configured. Verify settlement receipts through the external-wallet execution flow.',
      });
    }

    let previousStatus: string | undefined;
    let lastStatus = 'unknown';
    let attempt = 0;

    this.logger.log(
      `Starting settlement poll — tradeId=${tradeId} taskId=${taskId} ` +
        `maxAttempts=${this.maxAttempts} intervalMs=${this.pollIntervalMs}`,
    );

    while (attempt < this.maxAttempts) {
      attempt++;

      // Poll Mainnet settlement state
      const tradeStatus: SettlementTradeStatus = await getTradeStatus(tradeId);
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
    tradeStatus: SettlementTradeStatus,
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
