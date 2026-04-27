import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { TxPollJobData } from '../queue.types';
import { TransactionPollerService } from './transaction-poller.service';

/**
 * TxPollProcessor handles the business logic for transaction poll jobs.
 *
 * Responsibilities:
 * - Receive a BullMQ job from TxPollWorker
 * - Delegate to TransactionPollerService
 * - Log job lifecycle events
 */
@Injectable()
export class TxPollProcessor {
  private readonly logger = new Logger(TxPollProcessor.name);

  constructor(
    private readonly transactionPollerService: TransactionPollerService,
  ) {}

  async process(job: Job<TxPollJobData>): Promise<void> {
    const { taskId, txId, attempt } = job.data;

    this.logger.debug(
      `[job:${job.id}] TX poll job started — taskId=${taskId} txId=${txId} attempt=${attempt}`,
    );

    try {
      await this.transactionPollerService.poll(job.data);

      this.logger.debug(
        `[job:${job.id}] TX poll job completed — taskId=${taskId} txId=${txId}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `[job:${job.id}] TX poll job failed — taskId=${taskId} txId=${txId} error="${message}"`,
        error instanceof Error ? error.stack : undefined,
      );

      // Don't re-throw — the poller service handles re-enqueue logic internally.
      // If we throw here, BullMQ would retry the entire job, which conflicts
      // with our attempt-tracking strategy.
    }
  }
}
