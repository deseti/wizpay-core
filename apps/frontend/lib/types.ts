import type { Address, Hex } from "viem";
import type { RecipientDraft, TokenSymbol } from "@/lib/wizpay";

/* ── Step machine for approval / submit flows ── */
export type StepState =
  | "idle"
  | "signing"
  | "confirming"
  | "simulating"
  | "wallet"
  | "confirmed";

export type RecipientInputType = "address" | "ans" | "invalid";
export type RecipientResolutionState = "idle" | "loading" | "resolved" | "error";

/* ── Recipient row enriched with parsed amounts ── */
export interface PreparedRecipient extends RecipientDraft {
  validAddress: boolean;
  amountUnits: bigint;
  normalizedAddress: Address | null;
  ansDomain: string | null;
  recipientInputType: RecipientInputType;
  resolutionState: RecipientResolutionState;
  resolutionError: string | null;
}

/* ── Fee-aware quote from `getBatchEstimatedOutputs` ── */
export interface QuoteSummary {
  estimatedAmountsOut: bigint[];
  totalEstimatedOut: bigint;
  totalFees: bigint;
}

/* ── On-chain history item from BatchPaymentRouted events ── */
export interface HistoryItem {
  contractAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  totalAmountIn: bigint;
  totalAmountOut: bigint;
  totalFees: bigint;
  recipientCount: number;
  referenceId: string;
  txHash: Hex;
  blockNumber: bigint;
  timestampMs: number;
}

/* ── Unified history covering all dashboard event types ── */
export type HistoryActionType = "payroll" | "add_lp" | "remove_lp" | "swap" | "bridge" | "fx" | "ans";

/** One atomic step of a cross-chain bridge transfer. */
export interface NormalizedBridgeStep {
  id: string;
  name: string;
  state: string;
  chain: string | null;
  txId: string | null;
  explorerUrl: string | null;
}

/** Normalized result from a completed bridge transfer. Mirrors backend NormalizedBridgeTransfer. */
export interface NormalizedBridgeTransfer {
  transferId: string | null;
  status: string;
  sourceChain: string | null;
  destinationChain: string | null;
  txId: string | null;
  txIdBurn: string | null;
  txIdMint: string | null;
  steps: NormalizedBridgeStep[];
}

export interface UnifiedHistoryItem {
  type: HistoryActionType;
  txHash: Hex;
  blockNumber: bigint;
  timestampMs: number;
  /* Payroll-specific */
  tokenIn?: Address;
  tokenOut?: Address;
  totalAmountIn?: bigint;
  totalAmountOut?: bigint;
  totalFees?: bigint;
  recipientCount?: number;
  referenceId?: string;
  /* LP-specific */
  lpToken?: Address;
  lpAmount?: bigint;
  lpShares?: bigint;
  /* Bridge-specific */
  bridgeTransfer?: NormalizedBridgeTransfer;
  /* ANS-specific */
  ansDomain?: string;
  ansDurationYears?: number;
}

export interface TransactionActionResult {
  ok: boolean;
  hash: string | null;
  error?: string | null;
}

export type BackendTaskStatus =
  | "created"
  | "assigned"
  | "in_progress"
  | "review"
  | "executed"
  | "failed"
  | "approved"
  | "partial";

export type BackendTaskLogLevel = "INFO" | "ERROR";

export type BackendTaskUnitStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface BackendTaskLog {
  id: string;
  taskId: string;
  level: BackendTaskLogLevel;
  step: string;
  status: string;
  message: string;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface BackendTaskUnit {
  id: string;
  taskId: string;
  type: string;
  index: number;
  status: BackendTaskUnitStatus;
  txHash: string | null;
  error: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BackendTask {
  id: string;
  type: string;
  status: BackendTaskStatus;
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
  metadata: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  logs: BackendTaskLog[];
  units: BackendTaskUnit[];
}

export interface BackendTaskEmployeeBreakdownItem {
  taskId: string;
  date: number;
  employee: string;
  status: "Confirmed";
  amount: string;
  tokenSymbol: string;
  tokenDecimals: number;
  txHash: string;
}

export interface BackendPayrollHistoryEvent {
  txHash: string;
  blockNumber: string;
  timestampMs: number;
  tokenIn: string;
  tokenOut: string;
  totalAmountIn: string;
  totalAmountOut: string;
  totalFees: string;
  recipientCount: number;
  referenceId: string;
}

export interface BackendPayrollHistoryResponse {
  walletAddress: string;
  events: BackendPayrollHistoryEvent[];
  employeePayments: BackendTaskEmployeeBreakdownItem[];
}

export interface BackendTaskListResponse {
  items: BackendTask[];
  total: number;
}

/* ── The shape returned by useWizPay() ── */
export interface WizPayState {
  /* token selection */
  selectedToken: TokenSymbol;
  setSelectedToken: (token: TokenSymbol) => void;
  activeToken: { symbol: TokenSymbol; name: string; address: Address; decimals: number };

  /* recipients */
  recipients: RecipientDraft[];
  preparedRecipients: PreparedRecipient[];
  addRecipient: () => void;
  removeRecipient: (id: string) => void;
  updateRecipient: (id: string, field: keyof Omit<RecipientDraft, "id">, value: string) => void;

  /* reference */
  referenceId: string;
  setReferenceId: (value: string) => void;

  /* validation */
  errors: Record<string, string>;
  clearFieldError: (key: string) => void;

  /* amounts */
  batchAmount: bigint;
  validRecipientCount: number;

  /* contract reads */
  currentAllowance: bigint;
  currentBalance: bigint;
  feeBps: bigint;
  fxEngineData: Address | undefined;
  engineBalances: Record<TokenSymbol, bigint>;
  quoteSummary: QuoteSummary;
  allowanceLoading: boolean;
  balanceLoading: boolean;
  feeLoading: boolean;
  engineLoading: boolean;
  quoteLoading: boolean;
  quoteRefreshing: boolean;

  /* diagnostics */
  rowDiagnostics: (string | null)[];
  hasRouteIssue: boolean;
  approvalAmount: bigint;
  needsApproval: boolean;
  insufficientBalance: boolean;

  /* history */
  history: HistoryItem[];
  unifiedHistory: UnifiedHistoryItem[];
  historyLoading: boolean;
  totalRouted: bigint;

  /* tx state */
  approvalState: StepState;
  submitState: StepState;
  approveTxHash: Hex | null;
  submitTxHash: string | null;
  estimatedGas: bigint | null;
  statusMessage: string | null;
  errorMessage: string | null;
  isBusy: boolean;

  /* chunking state */
  pendingBatches: RecipientDraft[][];
  currentBatchNumber: number;
  totalBatches: number;
  sessionTotalAmount: bigint;
  setSessionTotalAmount: (amount: bigint | ((prev: bigint) => bigint)) => void;
  sessionTotalRecipients: number;
  setSessionTotalRecipients: (count: number | ((prev: number) => number)) => void;
  sessionTotalDistributed: Record<TokenSymbol, bigint>;
  setSessionTotalDistributed: (arg: Record<TokenSymbol, bigint> | ((prev: Record<TokenSymbol, bigint>) => Record<TokenSymbol, bigint>)) => void;

  /* actions */
  handleApprove: () => Promise<TransactionActionResult>;
  handleSubmit: () => Promise<TransactionActionResult>;
  resetComposer: () => void;
  loadNextBatch: () => void;
  dismissSuccessModal: () => void;
  setStatusMessage: (msg: string | null) => void;
  setErrorMessage: (msg: string | null) => void;
  importRecipients: (rows: RecipientDraft[]) => void;

  /* smart batch */
  smartBatchAvailable: boolean;
  smartBatchRunning: boolean;
  smartBatchReason: string | null;
  smartBatchButtonText: string | null;
  smartBatchHelperText: string | null;
  smartBatchSubmissionHashes: string[];
  payrollTaskId: string | null;
  payrollTask: BackendTask | null;
  handleSmartBatchSubmit: () => Promise<void>;

  /* clipboard */
  copiedHash: string | null;
  copyHash: (hash: string | null) => Promise<void>;

  /* derived text */
  primaryActionText: string;
  approvalText: string;
}
