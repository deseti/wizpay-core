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
import { TaskQueueJobData } from './queue.types';

/**
 * QueueService is responsible ONLY for enqueuing jobs.
 *
 * It does NOT process jobs — that responsibility belongs to:
 *   PayrollWorker  → PayrollProcessor → OrchestratorService → AgentRouterService
 *
 * Retry policy applied to every job:
 *   - attempts: 3
 *   - backoff: exponential (BullMQ doubles the delay between each retry)
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue<TaskQueueJobData>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly taskService: TaskService,
    private readonly telegramService: TelegramService,
  ) {}

  async enqueueTask(
    route: QueueRoutingDefinition,
    jobData: TaskQueueJobData,
  ): Promise<void> {
    const queue = this.getOrCreateQueue(route.queueName);

    await queue.add(`${jobData.taskType}:${jobData.taskId}`, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000, // 1 s → 2 s → 4 s
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

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map(async (queue) => queue.close()),
    );
  }

  private getOrCreateQueue(queueName: QueueName): Queue<TaskQueueJobData> {
    const existing = this.queues.get(queueName);

    if (existing) {
      return existing;
    }

    const queue = new Queue<TaskQueueJobData>(queueName, {
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