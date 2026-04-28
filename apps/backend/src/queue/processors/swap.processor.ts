import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { TaskQueueJobData } from '../queue.types';

@Injectable()
export class SwapProcessor {
  private readonly logger = new Logger(SwapProcessor.name);

  constructor(private readonly orchestratorService: OrchestratorService) {}

  async process(job: Job<TaskQueueJobData>): Promise<unknown> {
    const { taskId, taskType } = job.data;

    this.logger.log(
      `[job:${job.id}] ${taskType} job started — taskId=${taskId} attempt=${job.attemptsMade + 1}`,
    );

    try {
      const result = await this.orchestratorService.executeTask(taskId);

      this.logger.log(
        `[job:${job.id}] ${taskType} job completed — taskId=${taskId}`,
      );

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `[job:${job.id}] ${taskType} job failed — taskId=${taskId} error="${message}"`,
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }
  }
}