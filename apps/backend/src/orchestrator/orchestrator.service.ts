import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AgentRouterService } from '../agents/agent-router.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';
import { AgentExecutionResult } from '../agents/agent.interface';
import { TaskDetails, TaskPayload } from '../task/task.types';
import { TASK_QUEUE_MAP } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { TaskService } from '../task/task.service';
import { normalizeBridgeChain } from '../common/multichain';

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly taskService: TaskService,
    private readonly queueService: QueueService,
    private readonly agentRouterService: AgentRouterService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API — called by HTTP controller
  // ─────────────────────────────────────────────────────────────────────────────

  async handleTask(type: TaskType, payload: TaskPayload): Promise<TaskDetails> {
    const route = TASK_QUEUE_MAP[type];

    if (!route) {
      throw new BadRequestException(`Unsupported task type ${type}`);
    }

    // Enrich bridge payloads with canonical chain identifiers so metadata is
    // always queryable without re-parsing the raw blockchain string.
    const enrichedPayload =
      type === TaskType.BRIDGE
        ? this.enrichBridgePayload(payload)
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
    const taskType = task.type as TaskType;

    this.logger.log(
      `[orchestrator] Routing taskId=${task.id} to agent="${taskType}"`,
    );

    return this.agentRouterService.execute(taskType, task);
  }

  /**
   * Enrich a bridge payload with canonical chain identifiers.
   * Adds `destinationChain` and (when inferrable) `sourceChain` so that
   * these values are stored in task metadata at creation time, enabling
   * chain-aware worker routing in Phase 3 without re-parsing raw strings.
   */
  private enrichBridgePayload(payload: TaskPayload): TaskPayload {
    const blockchain =
      typeof payload.blockchain === 'string' ? payload.blockchain : null;
    const sourceBlockchain =
      typeof payload.sourceBlockchain === 'string'
        ? payload.sourceBlockchain
        : null;

    const destinationChain = normalizeBridgeChain(blockchain);
    const sourceChain = normalizeBridgeChain(sourceBlockchain);

    return {
      ...payload,
      ...(destinationChain ? { destinationChain } : {}),
      ...(sourceChain ? { sourceChain } : {}),
    };
  }
}