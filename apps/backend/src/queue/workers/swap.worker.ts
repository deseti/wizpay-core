import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { QueueName } from '../queue.constants';
import { TaskQueueJobData } from '../queue.types';
import { SwapProcessor } from '../processors/swap.processor';
import {
  assertSelectedJobNetwork,
  selectedQueuePrefix,
  selectedRedisConnection,
} from '../queue-runtime';

@Injectable()
export class SwapWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SwapWorker.name);
  private worker: Worker<TaskQueueJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly swapProcessor: SwapProcessor,
  ) {}

  onModuleInit(): void {
    this.logger.log('Starting swap worker...');

    this.worker = new Worker<TaskQueueJobData>(
      QueueName.SWAP,
      (job: Job<TaskQueueJobData>) => {
        assertSelectedJobNetwork(this.configService, job.data);
        return this.swapProcessor.process(job);
      },
      {
        connection: selectedRedisConnection(this.configService),
        prefix: selectedQueuePrefix(this.configService),
        concurrency: 3,
      },
    );

    this.worker.on('error', (error: Error) => {
      this.logger.error(`Swap worker error: ${error.message}`, error.stack);
    });

    this.worker.on('failed', (job, error: Error) => {
      this.logger.error(
        `[job:${job?.id}] Swap queue job permanently failed — taskId=${job?.data.taskId} error="${error.message}"`,
        error.stack,
      );
    });

    this.worker.on('completed', (job) => {
      this.logger.log(
        `[job:${job.id}] Swap queue job completed by worker — taskId=${job.data.taskId}`,
      );
    });

    this.logger.log('Swap worker started (concurrency=3)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log('Shutting down swap worker...');
      await this.worker.close();
      this.logger.log('Swap worker shut down');
    }
  }
}
