import { BackendApiError, backendFetch } from "@/lib/backend-api";

export interface CircleTransferStep {
  id: string;
  name: string;
  state: "pending" | "success" | "error" | "noop";
  txHash: string | null;
  explorerUrl: string | null;
  errorMessage: string | null;
  forwarded?: boolean;
  batched?: boolean;
}

export interface CircleTransfer {
  id?: string;
  stage?:
    | "pending"
    | "burning"
    | "attesting"
    | "minting"
    | "completed"
    | "failed";
  transferId: string;
  status: "pending" | "processing" | "settled" | "failed";
  rawStatus: string;
  txHash: string | null;
  txHashBurn?: string | null;
  txHashMint?: string | null;
  sourceWalletId?: string | null;
  walletId: string | null;
  walletAddress: string | null;
  sourceAddress: string | null;
  sourceChain?: CircleTransferBlockchain;
  sourceBlockchain: CircleTransferBlockchain;
  destinationChain?: CircleTransferBlockchain;
  destinationAddress: string | null;
  amount: string;
  tokenAddress: string;
  blockchain: CircleTransferBlockchain;
  provider: string | null;
  referenceId: string;
  createdAt: string;
  updatedAt: string;
  errorReason: string | null;
  steps: CircleTransferStep[];
}

export type CircleTransferBlockchain = "ARC-TESTNET" | "ETH-SEPOLIA" | "SOLANA-DEVNET";

export interface CircleTransferWalletBalance {
  amount: string;
  symbol: string | null;
  tokenAddress: string;
  updatedAt: string;
}

export interface CircleTransferWallet {
  walletSetId: string | null;
  walletId: string | null;
  walletAddress: string;
  blockchain: CircleTransferBlockchain;
  tokenAddress: string;
  balance: CircleTransferWalletBalance | null;
}

interface BootstrapCircleTransferWalletParams {
  walletSetId?: string;
  walletSetName?: string;
  walletName?: string;
  refId?: string;
  blockchain?: CircleTransferBlockchain;
  tokenAddress?: string;
}

interface GetCircleTransferWalletParams {
  walletId?: string;
  walletAddress?: string;
  blockchain?: CircleTransferBlockchain;
  tokenAddress?: string;
}

interface CreateCircleTransferParams {
  destinationAddress: string;
  amount: string;
  referenceId?: string;
  tokenAddress?: string;
  walletId?: string;
  walletAddress?: string;
  blockchain?: CircleTransferBlockchain;
  sourceBlockchain?: CircleTransferBlockchain;
}

interface BackendTaskLog {
  step: string;
  message: string;
  createdAt: string;
  context?: Record<string, unknown> | null;
}

interface BackendTaskRecord {
  id: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  logs: BackendTaskLog[];
  createdAt: string;
  updatedAt: string;
}

interface ApiErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
  data?: unknown;
}

export class TransferApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "TransferApiError";
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload;

  if (!response.ok) {
    throw new TransferApiError(
      payload.error || `API error ${response.status}`,
      response.status,
      payload.code,
      payload.details
    );
  }

  return (payload.data as T | undefined) ?? (payload as T);
}

export async function getCircleTransferWallet(
  params: GetCircleTransferWalletParams = {}
): Promise<CircleTransferWallet> {
  const searchParams = new URLSearchParams();

  if (params.walletId) {
    searchParams.set("walletId", params.walletId);
  }

  if (params.walletAddress) {
    searchParams.set("walletAddress", params.walletAddress);
  }

  if (params.blockchain) {
    searchParams.set("blockchain", params.blockchain);
  }

  if (params.tokenAddress) {
    searchParams.set("tokenAddress", params.tokenAddress);
  }

  const query = searchParams.toString();
  const url = query ? `/api/transfers/wallet?${query}` : "/api/transfers/wallet";

  return apiFetch<CircleTransferWallet>(url);
}

export async function bootstrapCircleTransferWallet(
  params: BootstrapCircleTransferWalletParams = {}
): Promise<CircleTransferWallet> {
  return apiFetch<CircleTransferWallet>("/api/transfers/wallet/bootstrap", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function createCircleTransfer(
  params: CreateCircleTransferParams
): Promise<CircleTransfer> {
  try {
    const task = await backendFetch<BackendTaskRecord>("/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "bridge",
        payload: {
          destinationAddress: params.destinationAddress,
          amount: params.amount,
          referenceId: params.referenceId,
          tokenAddress: params.tokenAddress,
          walletId: params.walletId,
          walletAddress: params.walletAddress,
          blockchain: params.blockchain,
          sourceBlockchain: params.sourceBlockchain,
        },
      }),
    });

    return mapBackendTaskToTransfer(task);
  } catch (error) {
    throw mapBackendErrorToTransferError(error);
  }
}

export async function getCircleTransferStatus(
  transferId: string
): Promise<CircleTransfer> {
  try {
    const task = await backendFetch<BackendTaskRecord>(
      `/tasks/${encodeURIComponent(transferId)}`
    );
    return mapBackendTaskToTransfer(task);
  } catch (error) {
    throw mapBackendErrorToTransferError(error);
  }
}

function mapBackendTaskToTransfer(task: BackendTaskRecord): CircleTransfer {
  const payload = task.payload ?? {};
  const transfer = readTransferResult(task.result);
  const executionPayload = readExecutionPayload(task.result);
  const rawStatus = mapTaskStatusToRawStatus(task.status, transfer);
  const status = mapTaskStatusToTransferStatus(task.status, transfer);
  const stage = mapRawStatusToStage(rawStatus, status);

  return {
    id: transfer?.id ?? task.id,
    transferId: transfer?.transferId ?? task.id,
    status,
    rawStatus,
    txHash: transfer?.txHash ?? null,
    txHashBurn: transfer?.txHashBurn ?? null,
    txHashMint: transfer?.txHashMint ?? null,
    sourceWalletId:
      transfer?.sourceWalletId ?? readString(executionPayload, "walletId") ?? null,
    walletId: transfer?.walletId ?? readString(payload, "walletId") ?? null,
    walletAddress:
      transfer?.walletAddress ?? readString(payload, "walletAddress") ?? null,
    sourceAddress:
      transfer?.sourceAddress ??
      readString(executionPayload, "walletAddress") ??
      readString(payload, "walletAddress") ??
      null,
    sourceChain: transfer?.sourceChain ?? readBlockchain(transfer, "sourceBlockchain"),
    sourceBlockchain:
      readBlockchain(transfer, "sourceBlockchain") ??
      readBlockchain(payload, "sourceBlockchain") ??
      getSourceBlockchain(readBlockchain(payload, "blockchain") ?? "ARC-TESTNET"),
    destinationChain: transfer?.destinationChain ?? readBlockchain(transfer, "blockchain"),
    destinationAddress:
      transfer?.destinationAddress ?? readString(payload, "destinationAddress") ?? null,
    amount: transfer?.amount ?? readString(payload, "amount") ?? "0",
    tokenAddress: transfer?.tokenAddress ?? readString(payload, "tokenAddress") ?? "",
    blockchain:
      readBlockchain(transfer, "blockchain") ??
      readBlockchain(payload, "blockchain") ??
      "ARC-TESTNET",
    provider: transfer?.provider ?? "circle",
    referenceId:
      transfer?.referenceId ?? readString(payload, "referenceId") ?? `BRIDGE-${task.id}`,
    createdAt: transfer?.createdAt ?? task.createdAt,
    updatedAt: transfer?.updatedAt ?? task.updatedAt,
    stage,
    errorReason:
      transfer?.errorReason ?? readTaskFailureMessage(task.logs) ?? null,
    steps:
      transfer?.steps && transfer.steps.length > 0
        ? transfer.steps
        : inferStepsFromTask(task, rawStatus, status),
  };
}

function readTransferResult(
  result: Record<string, unknown> | null
): CircleTransfer | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const execution = result.execution;

  if (!execution || typeof execution !== "object") {
    return null;
  }

  const transfer = (execution as Record<string, unknown>).transfer;

  if (!transfer || typeof transfer !== "object") {
    return null;
  }

  return transfer as CircleTransfer;
}

function readExecutionPayload(
  result: Record<string, unknown> | null
): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const execution = result.execution;

  if (!execution || typeof execution !== "object") {
    return {};
  }

  const payload = (execution as Record<string, unknown>).payload;
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function inferStepsFromTask(
  task: BackendTaskRecord,
  rawStatus: string,
  transferStatus: CircleTransfer["status"]
): CircleTransferStep[] {
  const burnSuccess = rawStatus === "burned" || rawStatus === "attested" || transferStatus === "settled";
  const attested = rawStatus === "attested" || transferStatus === "settled";
  const mintSuccess = transferStatus === "settled";
  const failed = transferStatus === "failed";
  const failureMessage = readTaskFailureMessage(task.logs);

  return [
    {
      id: "burn",
      name: "Burn on source chain",
      state: failed ? "error" : burnSuccess ? "success" : "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: failed ? failureMessage : null,
    },
    {
      id: "attestation",
      name: "Waiting for Circle attestation",
      state: failed ? "error" : attested ? "success" : "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: failed ? failureMessage : null,
    },
    {
      id: "mint",
      name: "Mint on destination chain",
      state: failed ? "error" : mintSuccess ? "success" : "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: failed ? failureMessage : null,
    },
  ];
}

function mapTaskStatusToTransferStatus(
  taskStatus: string,
  transfer: CircleTransfer | null
): CircleTransfer["status"] {
  if (transfer) {
    return transfer.status;
  }

  if (taskStatus === "executed") {
    return "settled";
  }

  if (taskStatus === "failed" || taskStatus === "partial") {
    return "failed";
  }

  if (taskStatus === "assigned") {
    return "pending";
  }

  return "processing";
}

function mapTaskStatusToRawStatus(
  taskStatus: string,
  transfer: CircleTransfer | null
): string {
  if (transfer?.rawStatus) {
    return transfer.rawStatus;
  }

  if (taskStatus === "assigned") {
    return "queued";
  }

  if (taskStatus === "in_progress") {
    return "processing";
  }

  if (taskStatus === "executed") {
    return "completed";
  }

  return taskStatus;
}

function mapRawStatusToStage(
  rawStatus: string,
  status: CircleTransfer["status"]
): CircleTransfer["stage"] {
  if (status === "settled") {
    return "completed";
  }

  if (status === "failed") {
    return "failed";
  }

  if (rawStatus === "burned") {
    return "attesting";
  }

  if (rawStatus === "attested") {
    return "minting";
  }

  return "pending";
}

function readTaskFailureMessage(logs: BackendTaskLog[]): string | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    if (log.step === "task.failed" || log.step === "bridge.failed") {
      return log.message;
    }
  }

  return null;
}

function readString(
  source: Record<string, unknown> | CircleTransfer | null,
  key: string
): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readBlockchain(
  source: Record<string, unknown> | CircleTransfer | null,
  key: string
): CircleTransferBlockchain | null {
  const value = readString(source, key);
  return value === "ARC-TESTNET" || value === "ETH-SEPOLIA" || value === "SOLANA-DEVNET"
    ? value
    : null;
}

function getSourceBlockchain(
  destination: CircleTransferBlockchain
): CircleTransferBlockchain {
  if (destination === "ARC-TESTNET") {
    return "ETH-SEPOLIA";
  }
  // ETH-SEPOLIA and SOLANA-DEVNET both bridge from Arc Testnet
  return "ARC-TESTNET";
}

function mapBackendErrorToTransferError(error: unknown): TransferApiError {
  if (error instanceof TransferApiError) {
    return error;
  }

  if (error instanceof BackendApiError) {
    return new TransferApiError(
      error.message,
      error.status,
      error.code,
      error.details
    );
  }

  if (error instanceof Error) {
    return new TransferApiError(error.message, 500);
  }

  return new TransferApiError("Unexpected bridge API error", 500);
}