import { BadRequestException, Injectable } from '@nestjs/common';
import { TASK_QUEUE_MAP } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { TaskService } from '../task/task.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails, TaskPayload } from '../task/task.types';

@Injectable()
export class OrchestratorService {
  constructor(
    private readonly taskService: TaskService,
    private readonly queueService: QueueService,
  ) {}

  async handleTask(type: TaskType, payload: TaskPayload): Promise<TaskDetails> {
    const route = TASK_QUEUE_MAP[type];

    if (!route) {
      throw new BadRequestException(`Unsupported task type ${type}`);
    }

    const task = await this.taskService.createTask(type, payload);

    try {
      await this.taskService.updateStatus(task.id, TaskStatus.ASSIGNED, {
        step: 'task.assigned',
        message: `Task routed to ${route.agentKey} agent on ${route.queueName} queue`,
      });

      await this.queueService.enqueueTask(route, {
        taskId: task.id,
        taskType: type,
        agentKey: route.agentKey,
        payload,
      });
    } catch (error) {
      await this.taskService.updateStatus(task.id, TaskStatus.FAILED, {
        step: 'orchestrator.failed',
        message:
          error instanceof Error ? error.message : 'Task orchestration failed',
      });

      throw error;
    }

    return this.taskService.getTaskById(task.id);
  }
}