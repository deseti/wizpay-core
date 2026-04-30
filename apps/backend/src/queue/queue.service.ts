import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
} from '../config/configuration';
import { TelegramService } from '../integrations/telegram.service';
import { TaskService } from '../task/task.service';
import { TaskStatus } from '../task/task-status.enum';
import { QueueName, QueueRoutingDefinition } from './queue.constants';
import { TaskQueueJobData, TxPollJobData } from './queue.types';

/**
 * QueueService is responsible ONLY for enqueuing jobs.
 *
 * It does NOT process jobs — that responsibility belongs to workers + processors.
 *
 * Supported queues:
 *   - payroll/swap/bridge → task execution via agents
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
  ) {}

  // ────────────────────────────────────────────────────────────────────
  //  Task enqueue (existing)
  // ────────────────────────────────────────────────────────────────────

  async enqueueTask(
    route: QueueRoutingDefinition,
    jobData: TaskQueueJobData,
  ): Promise<void> {
    const queue = this.getOrCreateQueue(route.queueName);

    await queue.add(`${jobData.taskType}:${jobData.taskId}`, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: jobData.taskType === 'bridge' ? 5000 : 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 500,
    });

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
    jobData: TxPollJobData,
    delayMs = 2000,
  ): Promise<void> {
    const queue = this.getOrCreateQueue(QueueName.TX_POLL);

    await queue.add(
      `tx_poll:${jobData.taskId}:${jobData.txId}`,
      jobData,
      {
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
      connection: this.getRedisConnectionOptions(),
    });

    this.queues.set(queueName, queue);

    this.logger.log(`Queue created — name=${queueName}`);

    return queue;
  }

  private getRedisConnectionOptions(): RedisOptions {
    return {
      host: this.configService.get<string>('REDIS_HOST') ?? DEFAULT_REDIS_HOST,
      port: this.configService.get<number>('REDIS_PORT') ?? DEFAULT_REDIS_PORT,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}