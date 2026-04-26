import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { TaskQueueJobData } from '../queue.types';

/**
 * PayrollProcessor handles the business logic for processing payroll jobs.
 *
 * Responsibilities:
 * - Receive a BullMQ job from the worker
 * - Delegate execution entirely to OrchestratorService
 * - Log job lifecycle events (start / success / failure)
 *
 * This processor MUST NOT call any agent directly — all routing goes
 * through the orchestrator.
 */
@Injectable()
export class PayrollProcessor {
  private readonly logger = new Logger(PayrollProcessor.name);

  constructor(private readonly orchestratorService: OrchestratorService) {}

  async process(job: Job<TaskQueueJobData>): Promise<unknown> {
    const { taskId } = job.data;

    this.logger.log(
      `[job:${job.id}] Payroll job started — taskId=${taskId} attempt=${job.attemptsMade + 1}`,
    );

    try {
      const result = await this.orchestratorService.executeTask(taskId);

      this.logger.log(
        `[job:${job.id}] Payroll job completed — taskId=${taskId}`,
      );

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `[job:${job.id}] Payroll job failed — taskId=${taskId} error="${message}"`,
        error instanceof Error ? error.stack : undefined,
      );

      // Re-throw so BullMQ can handle retries according to job options.
      throw error;
    }
  }
}
