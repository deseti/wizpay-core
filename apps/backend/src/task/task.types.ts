export type TaskPayload = Record<string, unknown>;

export type TaskLogLevel = 'INFO' | 'ERROR';

export type TaskUnitType = 'batch' | 'step';

export type TaskUnitStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface TaskLogRecord {
  id: string;
  taskId: string;
  level: TaskLogLevel;
  step: string;
  status: string;
  message: string;
  context: TaskPayload | null;
  createdAt: Date;
}

export interface TaskRecord {
  id: string;
  type: string;
  status: string;
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
  metadata: TaskPayload | null;
  payload: TaskPayload;
  result: TaskPayload | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskDetails extends TaskRecord {
  logs: TaskLogRecord[];
  units: TaskUnitRecord[];
  transactions: TaskTransactionRecord[];
}

export interface TaskUnitRecord {
  id: string;
  taskId: string;
  type: TaskUnitType;
  index: number;
  status: TaskUnitStatus;
  txHash: string | null;
  error: string | null;
  payload: TaskPayload;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePayrollTaskResult {
  taskId: string;
  approvalAmount: string;
  referenceId: string;
  totalUnits: number;
  units: Array<Pick<TaskUnitRecord, 'id' | 'index' | 'payload' | 'status' | 'type'>>;
}

export interface ReportTaskUnitInput {
  status: Extract<TaskUnitStatus, 'SUCCESS' | 'FAILED'>;
  txHash?: string | null;
  error?: string | null;
}

export interface ReportTaskUnitResult {
  task: TaskDetails;
  unit: TaskUnitRecord;
  nextUnit: Pick<TaskUnitRecord, 'id' | 'index' | 'payload' | 'status' | 'type'> | null;
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