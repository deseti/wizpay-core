import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
} from '../../config/configuration';
import { QueueName } from '../queue.constants';
import { TaskQueueJobData } from '../queue.types';
import { BridgeProcessor } from '../processors/bridge.processor';

@Injectable()
export class BridgeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BridgeWorker.name);
  private worker: Worker<TaskQueueJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly bridgeProcessor: BridgeProcessor,
  ) {}

  onModuleInit(): void {
    this.logger.log('Starting bridge worker...');

    this.worker = new Worker<TaskQueueJobData>(
      QueueName.BRIDGE,
      (job: Job<TaskQueueJobData>) => this.bridgeProcessor.process(job),
      {
        connection: this.getRedisConnectionOptions(),
        concurrency: 2,
      },
    );

    this.worker.on('error', (error: Error) => {
      this.logger.error(`Bridge worker error: ${error.message}`, error.stack);
    });

    this.worker.on('failed', (job, error: Error) => {
      this.logger.error(
        `[job:${job?.id}] Bridge job permanently failed — taskId=${job?.data.taskId} error="${error.message}"`,
        error.stack,
      );
    });

    this.worker.on('completed', (job) => {
      this.logger.log(
        `[job:${job.id}] Bridge job completed by worker — taskId=${job.data.taskId}`,
      );
    });

    this.logger.log('Bridge worker started (concurrency=2)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log('Shutting down bridge worker...');
      await this.worker.close();
      this.logger.log('Bridge worker shut down');
    }
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