import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ExecutionRouterService } from '../execution/execution-router.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';
import { AgentExecutionResult } from '../agents/agent.interface';
import { TaskDetails, TaskPayload } from '../task/task.types';
import { TASK_QUEUE_MAP } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { TaskService } from '../task/task.service';
import { CapabilityService } from '../capabilities/capability.service';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly queueService: QueueService,
    private readonly executionRouter: ExecutionRouterService,
    private readonly capabilities: CapabilityService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API — called by HTTP controller
  // ─────────────────────────────────────────────────────────────────────────────

  async handleTask(type: TaskType, payload: TaskPayload): Promise<TaskDetails> {
    this.assertTaskCapability(type, payload);
    if (type === TaskType.BRIDGE) {
      throw new BadRequestException(
        'Legacy bridge tasks were removed. Use the external-wallet /bridge/intents lifecycle.',
      );
    }
    if (type === TaskType.FX) {
      throw new ServiceUnavailableException({
        code: 'FX_TASK_TYPE_RETIRED',
        message:
          'FX tasks are retired on Arc Mainnet. Convert through the external-wallet Uniswap V4 flow.',
      });
    }

    const route = TASK_QUEUE_MAP[type];

    if (!route) {
      throw new BadRequestException(`Unsupported task type ${type}`);
    }

    const enrichedPayload = payload;

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
    this.assertTaskCapability(task.type as TaskType, task.payload);

    // ── Idempotency guard ────────────────────────────────────────────────────
    if (task.status !== 'assigned') {
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
      const isAsyncTask = task.type === 'payroll';

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

  private assertTaskCapability(type: TaskType, payload: TaskPayload) {
    if (type === TaskType.PAYROLL) this.capabilities.assertPayroll(payload);
    else if (type === TaskType.SWAP) this.capabilities.assert('swap');
    else if (type === TaskType.BRIDGE) this.capabilities.assert('bridge');
    else if (type === TaskType.FX)
      throw new ServiceUnavailableException({
        code: 'FX_TASK_TYPE_RETIRED',
        message:
          'FX tasks are retired on Arc Mainnet. Convert through the external-wallet Uniswap V4 flow.',
      });
    else if (type === TaskType.LIQUIDITY) this.capabilities.assert('liquidity');
  }

  async updateTaskState(
    taskId: string,
    state: string,
    result?: TaskPayload,
  ): Promise<void> {
    const statusMap: Record<string, TaskStatus> = {
      in_progress: TaskStatus.IN_PROGRESS,
      executed: TaskStatus.EXECUTED,
      failed: TaskStatus.FAILED,
    };

    const taskStatus = statusMap[state] || TaskStatus.ASSIGNED;

    await this.taskService.updateStatus(taskId, taskStatus, {
      step: `task.${state}`,
      message: `Task state updated to ${state}`,
      result,
    });
  }
}
