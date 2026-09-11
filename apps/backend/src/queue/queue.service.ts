import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { TelegramService } from '../integrations/telegram.service';
import { TaskService } from '../task/task.service';
import { TaskStatus } from '../task/task-status.enum';
import { QueueName, QueueRoutingDefinition } from './queue.constants';
import { TaskQueueJobData, TxPollJobData } from './queue.types';
import { CapabilityService } from '../capabilities/capability.service';
import {
  assertSelectedJobNetwork,
  selectedQueueNetwork,
  selectedQueuePrefix,
  selectedRedisConnection,
} from './queue-runtime';

type NewTaskQueueJobData = Omit<TaskQueueJobData, 'network'> &
  Partial<Pick<TaskQueueJobData, 'network'>>;
type NewTxPollJobData = Omit<TxPollJobData, 'network'> &
  Partial<Pick<TxPollJobData, 'network'>>;

/**
 * QueueService is responsible ONLY for enqueuing jobs.
 *
 * It does NOT process jobs — that responsibility belongs to workers + processors.
 *
 * Supported queues:
 *   - payroll/swap → task execution via agents
 *   - tx_poll → transaction status polling (non-blocking)
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly configService: ConfigService,
    private readonly taskService: TaskService,
    private readonly telegramService: TelegramService,
    private readonly capabilities: CapabilityService,
  ) {}

  // ────────────────────────────────────────────────────────────────────
  //  Task enqueue (existing)
  // ────────────────────────────────────────────────────────────────────

  async enqueueTask(
    route: QueueRoutingDefinition,
    input: NewTaskQueueJobData,
  ): Promise<void> {
    const jobData = this.bindSelectedNetwork(input);
    if (jobData.taskType === 'payroll')
      this.capabilities.assertPayroll(jobData.payload);
    else if (jobData.taskType === 'swap') this.capabilities.assert('swap');
    else if (jobData.taskType === 'bridge') this.capabilities.assert('bridge');
    else if (jobData.taskType === 'fx') this.capabilities.assert('stableFx');
    const queue = this.getOrCreateQueue(route.queueName);

    await queue.add(
      `${jobData.network}:${jobData.taskType}:${jobData.taskId}`,
      jobData,
      {
        jobId: `${jobData.network}--${jobData.taskType}--${jobData.taskId}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );

    this.logger.log(
      `Task enqueued — taskId=${jobData.taskId} queue=${route.queueName} attempts=3 backoff=exponential`,
    );

    await this.taskService.logStep(
      jobData.taskId,
      'queue.enqueued',
      TaskStatus.ASSIGNED,
      `Task queued on ${route.queueName}`,
    );

    await this.telegramService.notifyTaskUpdate(
      jobData.taskId,
      TaskStatus.ASSIGNED,
      `Task enqueued on ${route.queueName}`,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  //  Transaction poll enqueue (new — non-blocking architecture)
  // ────────────────────────────────────────────────────────────────────

  /**
   * Enqueue a transaction status poll job.
   *
   * Called by PayrollAgent after submitting each transfer to Circle.
   * The poll job will be picked up by TransactionPollerWorker, which
   * checks the Circle transaction status and either:
   *   - Marks the tx as completed/failed and checks task finalization
   *   - Re-enqueues with a delay if the tx is still pending
   *
   * @param jobData - The tx poll job data
   * @param delayMs - Optional delay before the job is processed (default: 2000ms for initial poll)
   */
  async enqueueTransactionPoll(
    input: NewTxPollJobData,
    delayMs = 2000,
  ): Promise<void> {
    const jobData = this.bindSelectedNetwork(input);
    const queue = this.getOrCreateQueue(QueueName.TX_POLL);

    await queue.add(
      `${jobData.network}:tx_poll:${jobData.taskId}:${jobData.txId}`,
      jobData,
      {
        jobId: `${jobData.network}--tx-poll--${jobData.taskId}--${jobData.txId}--${jobData.attempt}`,
        delay: delayMs,
        // No BullMQ-level retries — the poller service manages its own
        // re-enqueue logic with attempt tracking
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    );

    this.logger.debug(
      `TX poll enqueued — taskId=${jobData.taskId} txId=${jobData.txId} attempt=${jobData.attempt} delay=${delayMs}ms`,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  //  Lifecycle
  // ────────────────────────────────────────────────────────────────────

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map(async (queue) => queue.close()),
    );
  }

  // ────────────────────────────────────────────────────────────────────
  //  Internals
  // ────────────────────────────────────────────────────────────────────

  private getOrCreateQueue(queueName: string): Queue {
    const existing = this.queues.get(queueName);

    if (existing) {
      return existing;
    }

    const queue = new Queue(queueName, {
      connection: selectedRedisConnection(this.configService),
      prefix: selectedQueuePrefix(this.configService),
    });

    this.queues.set(queueName, queue);

    this.logger.log(`Queue created — name=${queueName}`);

    return queue;
  }

  private bindSelectedNetwork<
    T extends { network?: TaskQueueJobData['network'] },
  >(input: T): T & { network: TaskQueueJobData['network'] } {
    const network = selectedQueueNetwork(this.configService);
    if (input.network !== undefined) {
      assertSelectedJobNetwork(
        this.configService,
        input as { network: TaskQueueJobData['network'] },
      );
    }
    return { ...input, network };
  }
}
