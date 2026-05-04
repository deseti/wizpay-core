import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ExecutionRouterService } from '../execution/execution-router.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';
import { AgentExecutionResult } from '../agents/agent.interface';
import { TaskDetails, TaskPayload } from '../task/task.types';
import { TASK_QUEUE_MAP } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { TaskService } from '../task/task.service';
import { normalizeBridgeChain } from '../common/multichain';

type BridgeExecutionMode = 'app_treasury' | 'external_signer';
type BridgeSourceAccountType = 'app_treasury_wallet' | 'external_wallet';

const BRIDGE_EXTERNAL_ENABLED_ENV = 'WIZPAY_BRIDGE_EXTERNAL_ENABLED';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly queueService: QueueService,
    private readonly executionRouter: ExecutionRouterService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API — called by HTTP controller
  // ─────────────────────────────────────────────────────────────────────────────

  async handleTask(type: TaskType, payload: TaskPayload): Promise<TaskDetails> {
    const route = TASK_QUEUE_MAP[type];

    if (!route) {
      throw new BadRequestException(`Unsupported task type ${type}`);
    }

    const enrichedPayload =
      type === TaskType.BRIDGE
        ? this.normalizeBridgePayload(payload)
        : payload;

    const task = await this.taskService.createTask(type, enrichedPayload);

    try {
      await this.taskService.updateStatus(task.id, TaskStatus.ASSIGNED, {
        step: 'task.assigned',
        message: `Task routed to ${route.agentKey} agent on ${route.queueName} queue`,
      });

      await this.queueService.enqueueTask(route, {
        taskId: task.id,
        taskType: type,
        agentKey: route.agentKey,
        payload: enrichedPayload,
      });
    } catch (error) {
      await this.taskService.updateStatus(task.id, TaskStatus.FAILED, {
        step: 'orchestrator.failed',
        message:
          error instanceof Error ? error.message : 'Task orchestration failed',
      });

      throw error;
    }

    return this.taskService.getTaskById(task.id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Execution entry point — called ONLY by workers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute a previously enqueued task by its ID.
   *
   * Idempotency:
   * - Only tasks with status "assigned" are executed.
   * - Tasks already "in_progress" or "executed" are skipped silently.
   * - This makes worker retries safe: re-processing an already-completed task
   *   is a no-op.
   *
   * Flow:
   *   assigned → in_progress → [agent.execute()] → executed | failed
   */
  async executeTask(taskId: string): Promise<AgentExecutionResult | null> {
    const task = await this.taskService.getTaskById(taskId);

    // ── Idempotency guard ────────────────────────────────────────────────────
    if (task.status !== TaskStatus.ASSIGNED) {
      this.logger.warn(
        `[orchestrator] Skipping task ${taskId} — status is "${task.status}", expected "assigned"`,
      );
      return null;
    }

    this.logger.log(
      `[orchestrator] Execution started — taskId=${taskId} type=${task.type}`,
    );

    // ── Mark in-progress ────────────────────────────────────────────────────
    await this.taskService.updateStatus(taskId, TaskStatus.IN_PROGRESS, {
      step: 'task.in_progress',
      message: `Task picked up for execution`,
    });

    try {
      // ── Route to agent ──────────────────────────────────────────────────
      const result = await this.routeToAgent(task);

      // ── Determine finalization strategy ──────────────────────────────────
      //
      // ASYNC tasks (payroll): Agent returns submission results and enqueues
      //   poll jobs. Task stays in_progress. TransactionPollerService will
      //   finalize the task (executed/partial/failed) when all txs resolve.
      //
      // SYNC tasks (swap, bridge, etc): Agent blocks until completion and
      //   returns a final result. Task is marked executed immediately.
      //
      const isAsyncTask = task.type === TaskType.PAYROLL;

      if (isAsyncTask) {
        // Store submission result but keep status as in_progress
        await this.taskService.logStep(
          taskId,
          'task.submissions_complete',
          TaskStatus.IN_PROGRESS,
          `Agent submitted all transfers. Awaiting confirmations via tx_poll queue.`,
        );

        this.logger.log(
          `[orchestrator] Agent submissions complete (async) — taskId=${taskId} type=${task.type}`,
        );
      } else {
        // Synchronous task — mark executed immediately
        await this.taskService.updateStatus(taskId, TaskStatus.EXECUTED, {
          step: 'task.executed',
          message: 'Task execution completed',
          result,
        });

        this.logger.log(
          `[orchestrator] Execution success (sync) — taskId=${taskId} type=${task.type}`,
        );
      }

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Task execution failed';

      this.logger.error(
        `[orchestrator] Execution failed — taskId=${taskId} type=${task.type} error="${message}"`,
        error instanceof Error ? error.stack : undefined,
      );

      // ── Mark failed (best-effort, never swallow the original error) ─────
      try {
        await this.taskService.updateStatus(taskId, TaskStatus.FAILED, {
          step: 'task.failed',
          message,
        });
      } catch (statusError) {
        const fallback =
          statusError instanceof Error
            ? statusError.message
            : 'Unable to update task status to failed';

        this.logger.error(
          `[orchestrator] Could not update status to failed — taskId=${taskId} reason="${fallback}"`,
        );

        await this.taskService.logStep(
          taskId,
          'task.failed.log',
          TaskStatus.FAILED,
          fallback,
        );
      }

      // Re-throw so BullMQ registers the job as failed and applies retry policy.
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal routing — agents are NEVER exposed to workers
  // ─────────────────────────────────────────────────────────────────────────────

  private async routeToAgent(task: TaskDetails): Promise<AgentExecutionResult> {
    this.logger.log(
      `[orchestrator] Routing taskId=${task.id} type=${task.type} → execution router`,
    );

    return this.executionRouter.execute(task);
  }

  private normalizeBridgePayload(payload: TaskPayload): TaskPayload {
    const bridgeExecutionMode = this.readBridgeExecutionMode(payload);
    const sourceAccountType = this.readBridgeSourceAccountType(
      payload,
      bridgeExecutionMode,
    );
    const bridgeExternalEnabled = this.isBridgeExternalEnabled();

    if (bridgeExecutionMode === 'external_signer' && !bridgeExternalEnabled) {
      throw new BadRequestException({
        code: 'BRIDGE_EXTERNAL_DISABLED',
        error:
          'External wallet bridge is currently disabled by server feature flag.',
        details: {
          bridgeExecutionMode,
          env: BRIDGE_EXTERNAL_ENABLED_ENV,
        },
      });
    }

    const sourceBlockchain = this.readChain(
      payload,
      'sourceBlockchain',
      'sourceChain',
    );
    const destinationBlockchain = this.readChain(
      payload,
      'destinationBlockchain',
      'destinationChain',
      'blockchain',
    );
    const sourceChain = normalizeBridgeChain(sourceBlockchain);
    const destinationChain = normalizeBridgeChain(destinationBlockchain);
    const token = this.readString(payload, 'token') ?? 'USDC';
    const amount = this.readString(payload, 'amount');
    const walletId = this.readString(payload, 'walletId');
    const walletAddress = this.readString(payload, 'walletAddress');
    const destinationAddress = this.readString(payload, 'destinationAddress');

    // walletId only exists for backend-controlled treasury wallets.
    // Passkey and browser-wallet external signers do not provide one.
    const isPasskey = this.readString(payload, 'walletMode') === 'PASSKEY';
    const isExternalWalletSource = sourceAccountType === 'external_wallet';

    const missing = [
      !sourceBlockchain ? 'sourceChain' : null,
      !destinationBlockchain ? 'destinationChain' : null,
      !amount ? 'amount' : null,
      (!walletId && !isPasskey && !isExternalWalletSource)
        ? 'walletId'
        : null,
      !walletAddress ? 'walletAddress' : null,
      !destinationAddress ? 'destinationAddress' : null,
    ].filter((field): field is string => Boolean(field));

    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'BRIDGE_VALIDATION_FAILED',
        error: `Missing required bridge field(s): ${missing.join(', ')}`,
        details: { missing },
      });
    }

    if (!sourceChain || !destinationChain) {
      throw new BadRequestException({
        code: 'BRIDGE_CHAIN_UNSUPPORTED',
        error:
          'Bridge supports ARC-TESTNET, ETH-SEPOLIA, and SOLANA-DEVNET only.',
        details: { destinationBlockchain, sourceBlockchain },
      });
    }

    if (sourceBlockchain === destinationBlockchain) {
      throw new BadRequestException({
        code: 'BRIDGE_SAME_CHAIN',
        error: 'Bridge source and destination chains must be different.',
      });
    }

    if (token.trim().toUpperCase() !== 'USDC') {
      throw new BadRequestException({
        code: 'BRIDGE_USDC_ONLY',
        error: 'Bridge currently supports USDC only.',
      });
    }

    if (Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
      throw new BadRequestException({
        code: 'BRIDGE_INVALID_AMOUNT',
        error: 'Bridge amount must be a positive string.',
      });
    }

    const requiredSourceBlockchain = sourceBlockchain;
    const requiredDestinationBlockchain = destinationBlockchain;
    const requiredDestinationAddress = destinationAddress;
    const requiredWalletAddress = walletAddress;

    if (
      !requiredSourceBlockchain ||
      !requiredDestinationBlockchain ||
      !requiredDestinationAddress ||
      !requiredWalletAddress
    ) {
      throw new BadRequestException({
        code: 'BRIDGE_VALIDATION_FAILED',
        error:
          'Bridge requires sourceChain, destinationChain, destinationAddress, and walletAddress.',
      });
    }

    const normalizedDestinationAddress = this.normalizeBridgeAddress(
      requiredDestinationAddress,
      requiredDestinationBlockchain,
    );
    const normalizedWalletAddress = this.normalizeBridgeAddress(
      requiredWalletAddress,
      requiredSourceBlockchain,
    );

    this.logger.log(
      `[bridge] mode=${bridgeExecutionMode} source_account=${sourceAccountType} external_enabled=${bridgeExternalEnabled} source=${requiredSourceBlockchain} destination=${requiredDestinationBlockchain}`,
    );

    return {
      ...payload,
      amount: String(amount),
      blockchain: requiredDestinationBlockchain,
      bridgeExecutionMode,
      sourceAccountType,
      destinationAddress: normalizedDestinationAddress,
      destinationBlockchain: requiredDestinationBlockchain,
      destinationChain,
      sourceBlockchain: requiredSourceBlockchain,
      sourceChain,
      token: 'USDC',
      walletAddress: normalizedWalletAddress,
      walletId,
    };
  }

  private readBridgeExecutionMode(payload: TaskPayload): BridgeExecutionMode {
    const mode = this.readString(payload, 'bridgeExecutionMode');

    if (!mode || mode === 'app_treasury') {
      return 'app_treasury';
    }

    if (mode === 'external_signer') {
      return 'external_signer';
    }

    throw new BadRequestException({
      code: 'BRIDGE_EXECUTION_MODE_INVALID',
      error:
        'bridgeExecutionMode must be either "app_treasury" or "external_signer".',
      details: {
        bridgeExecutionMode: mode,
      },
    });
  }

  private readBridgeSourceAccountType(
    payload: TaskPayload,
    bridgeExecutionMode: BridgeExecutionMode,
  ): BridgeSourceAccountType {
    const value = this.readString(payload, 'sourceAccountType');

    if (!value) {
      return bridgeExecutionMode === 'external_signer'
        ? 'external_wallet'
        : 'app_treasury_wallet';
    }

    if (value === 'app_treasury_wallet' || value === 'external_wallet') {
      return value;
    }

    throw new BadRequestException({
      code: 'BRIDGE_SOURCE_ACCOUNT_TYPE_INVALID',
      error:
        'sourceAccountType must be either "app_treasury_wallet" or "external_wallet".',
      details: {
        sourceAccountType: value,
      },
    });
  }

  private isBridgeExternalEnabled() {
    const value = process.env[BRIDGE_EXTERNAL_ENABLED_ENV];

    if (!value) {
      return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  private readChain(payload: TaskPayload, ...keys: string[]): string | null {
    for (const key of keys) {
      const value = this.readString(payload, key);

      if (value) {
        return value.toUpperCase().replace(/_/g, '-');
      }
    }

    return null;
  }

  private readString(payload: TaskPayload, key: string): string | null {
    const value = payload[key];

    if (typeof value === 'number') {
      return String(value);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeBridgeAddress(address: string, blockchain: string): string {
    return blockchain === 'SOLANA-DEVNET' ? address : address.toLowerCase();
  }

  async updateTaskState(taskId: string, state: string, result?: any) {
    const statusMap: Record<string, TaskStatus> = {
      'in_progress': TaskStatus.IN_PROGRESS,
      'executed': TaskStatus.EXECUTED,
      'failed': TaskStatus.FAILED,
    };
    
    const taskStatus = statusMap[state] || TaskStatus.ASSIGNED;
    
    await this.taskService.updateStatus(taskId, taskStatus, {
      step: `task.${state}`,
      message: `Task state updated to ${state}`,
      result,
    });
  }
}
