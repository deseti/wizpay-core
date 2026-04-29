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

export interface CreateSwapTaskResult {
  taskId: string;
  unitId: string;
  referenceId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  recipient: string;
}

export interface CreateLiquidityTaskResult {
  taskId: string;
  unitId: string;
  operation: 'add' | 'remove';
  token: string;
  amount: string;
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

// ─── Normalized bridge transfer (official result contract) ────────────────────

/** One atomic step of a cross-chain bridge transfer (e.g. burn, attest, mint). */
export interface NormalizedBridgeStep {
  /** Opaque step ID from the bridge provider. */
  id: string;
  /** Human-readable step name (e.g. "burn", "attest", "mint"). */
  name: string;
  /** Provider-reported state (e.g. "complete", "pending"). */
  state: string;
  /** Canonical chain this step executed on, or null if unknown. */
  chain: string | null;
  /** Validated transaction hash or Solana signature, or null. */
  txId: string | null;
  /** Provider-supplied explorer URL for this step, or null. */
  explorerUrl: string | null;
}

/**
 * Normalized, chain-agnostic bridge transfer result.
 * Stored at `task.result.execution.normalizedTransfer`.
 */
export interface NormalizedBridgeTransfer {
  /** Provider transfer ID. */
  transferId: string | null;
  /** Terminal status of the transfer ("settled" | "failed" | …). */
  status: string;
  /** Canonical source chain (e.g. "arc_testnet"). */
  sourceChain: string | null;
  /** Canonical destination chain (e.g. "solana_devnet"). */
  destinationChain: string | null;
  /** Top-level transaction ID when provider returns a single hash. */
  txId: string | null;
  /** Burn-phase tx hash / Solana signature. */
  txIdBurn: string | null;
  /** Mint-phase tx hash / Solana signature. */
  txIdMint: string | null;
  /** Ordered list of bridge steps. */
  steps: NormalizedBridgeStep[];
}