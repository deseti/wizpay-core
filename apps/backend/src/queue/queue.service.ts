import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { AgentRouterService } from '../agents/agent-router.service';
import { PayrollAgent } from '../agents/payroll/payroll.agent';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
} from '../config/configuration';
import { TelegramService } from '../integrations/telegram.service';
import { TaskService } from '../task/task.service';
import { TaskStatus } from '../task/task-status.enum';
import { QueueName, QueueRoutingDefinition } from './queue.constants';
import { TaskQueueJobData } from './queue.types';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue<TaskQueueJobData>>();
  private readonly workers = new Map<QueueName, Worker<TaskQueueJobData>>();
  private readonly runningWorkers = new Set<QueueName>();

  constructor(
    private readonly configService: ConfigService,
    private readonly taskService: TaskService,
    private readonly agentRouterService: AgentRouterService,
    private readonly payrollAgent: PayrollAgent,
    private readonly telegramService: TelegramService,
  ) {}

  async enqueueTask(
    route: QueueRoutingDefinition,
    jobData: TaskQueueJobData,
  ): Promise<void> {
    const queue = this.getQueue(route.queueName);

    await queue.add(`${jobData.taskType}:${jobData.taskId}`, jobData, {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 500,
    });

    await this.taskService.logStep(
      jobData.taskId,
      'queue.enqueued',
      TaskStatus.ASSIGNED,
      `Task queued on ${route.queueName}`,
    );

    this.startWorker(route.queueName);
  }

  async onModuleDestroy() {
    await Promise.all(
      [...this.workers.values()].map(async (worker) => worker.close()),
    );
    await Promise.all(
      [...this.queues.values()].map(async (queue) => queue.close()),
    );
  }

  private getQueue(queueName: QueueName): Queue<TaskQueueJobData> {
    const existingQueue = this.queues.get(queueName);

    if (existingQueue) {
      return existingQueue;
    }

    const queue = new Queue<TaskQueueJobData>(queueName, {
      connection: this.getRedisConnectionOptions(),
    });

    this.queues.set(queueName, queue);

    return queue;
  }

  private getWorker(queueName: QueueName): Worker<TaskQueueJobData> {
    const existingWorker = this.workers.get(queueName);

    if (existingWorker) {
      return existingWorker;
    }

    const worker = new Worker<TaskQueueJobData>(
      queueName,
      async (job) => this.processJob(queueName, job),
      {
        connection: this.getRedisConnectionOptions(),
        autorun: false,
        concurrency: 5,
      },
    );

    worker.on('error', (error) => {
      this.logger.error(
        `Queue worker ${queueName} failed: ${error.message}`,
        error.stack,
      );
    });

    this.workers.set(queueName, worker);

    return worker;
  }

  private startWorker(queueName: QueueName) {
    if (this.runningWorkers.has(queueName)) {
      return;
    }

    this.runningWorkers.add(queueName);

    const worker = this.getWorker(queueName);

    void worker.run().catch((error: Error) => {
      this.runningWorkers.delete(queueName);
      this.logger.error(
        `Queue worker ${queueName} stopped: ${error.message}`,
        error.stack,
      );
    });
  }

  private async processJob(queueName: QueueName, job: Job<TaskQueueJobData>) {
    if (queueName === QueueName.PAYROLL) {
      return this.processPayrollJob(job);
    }

    return this.processRoutedJob(job);
  }

  private async processPayrollJob(job: Job<TaskQueueJobData>) {
    try {
      const task = await this.taskService.getTaskById(job.data.taskId);
      const result = await this.payrollAgent.execute(task);

      await this.telegramService.notifyTaskUpdate(
        task.id,
        TaskStatus.EXECUTED,
        'Task execution completed',
      );

      return result;
    } catch (error) {
      await this.failTask(job.data.taskId, error);
      throw error;
    }
  }

  private async processRoutedJob(job: Job<TaskQueueJobData>) {
    try {
      const task = await this.taskService.getTaskById(job.data.taskId);

      await this.taskService.updateStatus(task.id, TaskStatus.IN_PROGRESS, {
        step: 'task.in_progress',
        message: `Task picked by ${job.data.agentKey} agent`,
      });

      const result = await this.agentRouterService.execute(job.data.agentKey, task);

      await this.taskService.updateStatus(task.id, TaskStatus.REVIEW, {
        step: 'task.review',
        message: 'Task output prepared for review',
      });

      await this.taskService.updateStatus(task.id, TaskStatus.APPROVED, {
        step: 'task.approved',
        message: 'Task approved for execution',
      });

      await this.taskService.updateStatus(task.id, TaskStatus.EXECUTED, {
        step: 'task.executed',
        message: 'Task execution completed',
        result,
      });

      await this.telegramService.notifyTaskUpdate(
        task.id,
        TaskStatus.EXECUTED,
        'Task execution completed',
      );

      return result;
    } catch (error) {
      await this.failTask(job.data.taskId, error);
      throw error;
    }
  }

  private async failTask(taskId: string, error: unknown) {
    const message = error instanceof Error ? error.message : 'Task execution failed';

    try {
      await this.taskService.updateStatus(taskId, TaskStatus.FAILED, {
        step: 'task.failed',
        message,
      });
    } catch (statusError) {
      const fallbackMessage =
        statusError instanceof Error ? statusError.message : 'Unable to update task status';

      await this.taskService.logStep(
        taskId,
        'task.failed.log',
        TaskStatus.FAILED,
        fallbackMessage,
      );
    }

    await this.telegramService.notifyTaskUpdate(taskId, TaskStatus.FAILED, message);
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