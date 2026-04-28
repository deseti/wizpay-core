import { TaskType } from '../task/task-type.enum';

export enum QueueName {
  PAYROLL = 'payroll',
  SWAP = 'swap',
  BRIDGE = 'bridge',
  /** Queue for polling Circle transaction status (non-blocking) */
  TX_POLL = 'tx_poll',
}

export interface QueueRoutingDefinition {
  queueName: QueueName;
  agentKey: TaskType;
}

export const TASK_QUEUE_MAP: Record<TaskType, QueueRoutingDefinition> = {
  [TaskType.PAYROLL]: {
    queueName: QueueName.PAYROLL,
    agentKey: TaskType.PAYROLL,
  },
  [TaskType.SWAP]: {
    queueName: QueueName.SWAP,
    agentKey: TaskType.SWAP,
  },
  [TaskType.BRIDGE]: {
    queueName: QueueName.BRIDGE,
    agentKey: TaskType.BRIDGE,
  },
  [TaskType.LIQUIDITY]: {
    queueName: QueueName.SWAP,
    agentKey: TaskType.LIQUIDITY,
  },
  [TaskType.FX]: {
    queueName: QueueName.SWAP,
    agentKey: TaskType.FX,
  },
};