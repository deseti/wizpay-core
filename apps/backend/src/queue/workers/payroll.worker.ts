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
import { PayrollProcessor } from '../processors/payroll.processor';
import {
  assertSelectedJobNetwork,
  selectedQueuePrefix,
  selectedRedisConnection,
} from '../queue-runtime';

/**
 * PayrollWorker bootstraps and manages the BullMQ Worker for the "payroll" queue.
 *
 * Architecture contract:
 * - Worker only pulls jobs from the queue and calls the processor
 * - Processor delegates all execution to OrchestratorService
 * - Worker NEVER calls agents directly
 *
 * Lifecycle:
 * - Worker starts automatically on module init (OnModuleInit)
 * - Worker closes gracefully on module destroy (OnModuleDestroy)
 */
@Injectable()
export class PayrollWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayrollWorker.name);
  private worker: Worker<TaskQueueJobData> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly payrollProcessor: PayrollProcessor,
  ) {}

  onModuleInit(): void {
    this.logger.log('Starting payroll worker...');

    this.worker = new Worker<TaskQueueJobData>(
      QueueName.PAYROLL,
      (job: Job<TaskQueueJobData>) => {
        assertSelectedJobNetwork(this.configService, job.data);
        return this.payrollProcessor.process(job);
      },
      {
        connection: selectedRedisConnection(this.configService),
        prefix: selectedQueuePrefix(this.configService),
        concurrency: 5,
      },
    );

    this.worker.on('error', (error: Error) => {
      this.logger.error(`Payroll worker error: ${error.message}`, error.stack);
    });

    this.worker.on('failed', (job, error: Error) => {
      this.logger.error(
        `[job:${job?.id}] Payroll job permanently failed — taskId=${job?.data.taskId} error="${error.message}"`,
        error.stack,
      );
    });

    this.worker.on('completed', (job) => {
      this.logger.log(
        `[job:${job.id}] Payroll job confirmed completed by worker — taskId=${job.data.taskId}`,
      );
    });

    this.logger.log('Payroll worker started (concurrency=5)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log('Shutting down payroll worker...');
      await this.worker.close();
      this.logger.log('Payroll worker shut down');
    }
  }
}
