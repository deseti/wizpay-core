import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrchestratorService } from '../../orchestrator/orchestrator.service';
import { TaskQueueJobData } from '../queue.types';

@Injectable()
export class BridgeProcessor {
  private readonly logger = new Logger(BridgeProcessor.name);

  constructor(private readonly orchestratorService: OrchestratorService) {}

  async process(job: Job<TaskQueueJobData>): Promise<unknown> {
    const { taskId } = job.data;

    this.logger.log(
      `[job:${job.id}] Bridge job started — taskId=${taskId} attempt=${job.attemptsMade + 1}`,
    );

    try {
      const result = await this.orchestratorService.executeTask(taskId);

      this.logger.log(`[job:${job.id}] Bridge job completed — taskId=${taskId}`);

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `[job:${job.id}] Bridge job failed — taskId=${taskId} error="${message}"`,
        error instanceof Error ? error.stack : undefined,
      );

      throw error;
    }
  }
}