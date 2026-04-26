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
}