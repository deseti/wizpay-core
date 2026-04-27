import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
} from '../../config/configuration';
import { QueueName } from '../queue.constants';
import { TxPollJobData } from '../queue.types';
import { TxPollProcessor } from '../processors/tx-poll.processor';

/**
 * TxPollWorker bootstraps and manages the BullMQ Worker for the "tx_poll" queue.
 *
 * This worker processes transaction status poll jobs:
 *   - Checks Circle transaction status
 *   - Updates task transaction records
 *   - Re-enqueues pending transactions
 *   - Finalizes task status when all transactions complete
 *
 * Concurrency is set high (10) since each poll job is a single lightweight
 * HTTP call to Circle + a DB update. No heavy computation.
 */
@Injectable()
export class TxPollWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TxPollWorker.name);
  private worker: Worker<TxPollJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly txPollProcessor: TxPollProcessor,
  ) {}

  onModuleInit(): void {
    this.logger.log('Starting tx_poll worker...');

    this.worker = new Worker<TxPollJobData>(
      QueueName.TX_POLL,
      (job: Job<TxPollJobData>) => this.txPollProcessor.process(job),
      {
        connection: this.getRedisConnectionOptions(),
        concurrency: 10,
      },
    );

    this.worker.on('error', (error: Error) => {
      this.logger.error(
        `TX poll worker error: ${error.message}`,
        error.stack,
      );
    });

    this.worker.on('failed', (job, error: Error) => {
      this.logger.error(
        `[job:${job?.id}] TX poll job permanently failed — txId=${job?.data.txId} error="${error.message}"`,
        error.stack,
      );
    });

    this.logger.log('TX poll worker started (concurrency=10)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log('Shutting down tx_poll worker...');
      await this.worker.close();
      this.logger.log('TX poll worker shut down');
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
