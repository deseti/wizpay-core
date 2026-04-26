import { TaskDetails, TaskPayload } from '../task/task.types';

export type AgentExecutionResult = TaskPayload;

export interface TaskAgent {
  execute(task: TaskDetails): Promise<AgentExecutionResult>;
}