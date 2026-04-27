import { TaskType } from '../task/task-type.enum';
import { TaskPayload } from '../task/task.types';

export interface TaskQueueJobData {
  taskId: string;
  taskType: TaskType;
  agentKey: TaskType;
  payload: TaskPayload;
}

/**
 * Job data for the TX_POLL queue.
 * Each job represents one Circle transaction that needs status polling.
 */
export interface TxPollJobData {
  taskId: string;
  txId: string;
  /** Current poll attempt (0-indexed). Used to enforce max attempts. */
  attempt: number;
}