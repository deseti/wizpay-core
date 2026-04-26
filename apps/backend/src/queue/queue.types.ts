import { TaskType } from '../task/task-type.enum';
import { TaskPayload } from '../task/task.types';

export interface TaskQueueJobData {
  taskId: string;
  taskType: TaskType;
  agentKey: TaskType;
  payload: TaskPayload;
}