export type TaskPayload = Record<string, unknown>;

export interface TaskLogRecord {
  id: string;
  taskId: string;
  step: string;
  status: string;
  message: string;
  createdAt: Date;
}

export interface TaskRecord {
  id: string;
  type: string;
  status: string;
  payload: TaskPayload;
  result: TaskPayload | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDetails extends TaskRecord {
  logs: TaskLogRecord[];
  transactions: TaskTransactionRecord[];
}

// ─── Transaction tracking ─────────────────────────────────────────

export type TxStatus = 'pending' | 'completed' | 'failed';

export interface TaskTransactionRecord {
  id: string;
  taskId: string;
  txId: string;
  recipient: string;
  amount: string;
  currency: string;
  status: TxStatus;
  txHash: string | null;
  errorReason: string | null;
  batchIndex: number;
  pollAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppendTransactionInput {
  taskId: string;
  txId: string;
  recipient: string;
  amount: string;
  currency: string;
  batchIndex: number;
}

export interface UpdateTransactionInput {
  status: TxStatus;
  txHash?: string | null;
  errorReason?: string | null;
  pollAttempts?: number;
}