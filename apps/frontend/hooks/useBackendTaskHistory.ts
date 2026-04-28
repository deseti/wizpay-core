"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { backendFetch } from "@/lib/backend-api";
import { USDC_ADDRESS, EURC_ADDRESS } from "@/constants/addresses";
import { isTransactionHash } from "@/lib/wizpay";
import type {
  BackendTask,
  BackendTaskListResponse,
  HistoryActionType,
  UnifiedHistoryItem,
} from "@/lib/types";

function asAddress(value: unknown): Address | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    return normalized.toLowerCase() as Address;
  }
  if (normalized.toUpperCase() === "USDC") return USDC_ADDRESS;
  if (normalized.toUpperCase() === "EURC") return EURC_ADDRESS;
  return undefined;
}

function toBigIntValue(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Map backend task type → HistoryActionType */
function toHistoryActionType(taskType: string): HistoryActionType | null {
  switch (taskType) {
    case "payroll":
      return "payroll";
    case "swap":
      return "swap";
    case "bridge":
      return "bridge";
    case "liquidity": {
      // operation stored in metadata
      return null; // resolved per-task below
    }
    case "fx":
      return "fx";
    default:
      return null;
  }
}

function liquidityActionType(task: BackendTask): HistoryActionType {
  const op = task.metadata?.operation ?? task.payload?.operation;
  return op === "remove" ? "remove_lp" : "add_lp";
}

function resolveTaskTxHash(task: BackendTask): `0x${string}` | null {
  const candidates = [
    task.units[0]?.txHash,
    task.result?.txHash,
    task.result?.execution?.txHash,
    task.result?.execution?.transfer?.txHash,
    task.result?.execution?.transfer?.txHashMint,
    task.result?.execution?.transfer?.txHashBurn,
  ];

  for (const candidate of candidates) {
    if (isTransactionHash(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Convert a backend task to a UnifiedHistoryItem for display */
export function backendTaskToHistoryItem(
  task: BackendTask
): UnifiedHistoryItem | null {
  const txHash = resolveTaskTxHash(task);

  const createdAt = new Date(task.createdAt).getTime();

  let type: HistoryActionType;
  if (task.type === "liquidity") {
    type = liquidityActionType(task);
  } else {
    const mapped = toHistoryActionType(task.type);
    if (!mapped) return null;
    type = mapped;
  }

  const meta = task.metadata ?? {};
  const payload = task.payload ?? {};
  const tokenIn = asAddress(meta.tokenIn ?? payload.tokenIn ?? meta.sourceToken ?? payload.sourceToken);
  const tokenOut = asAddress(meta.tokenOut ?? payload.tokenOut ?? payload.targetToken);
  const totalAmountIn =
    toBigIntValue(meta.amountIn) ??
    toBigIntValue(payload.amountIn) ??
    toBigIntValue(meta.totalAmount) ??
    toBigIntValue(payload.totalAmount) ??
    toBigIntValue(meta.amount) ??
    toBigIntValue(payload.amount);

  return {
    type,
    txHash: txHash ?? "0x",
    blockNumber: 0n,
    timestampMs: createdAt,
    // payroll
    tokenIn,
    tokenOut,
    totalAmountIn,
    totalAmountOut: undefined,
    totalFees: undefined,
    recipientCount:
      typeof meta.totalRecipients === "number"
        ? meta.totalRecipients
        : typeof payload.recipientCount === "number"
        ? payload.recipientCount
        : undefined,
    referenceId:
      typeof meta.referenceId === "string"
        ? meta.referenceId
        : typeof payload.referenceId === "string"
        ? payload.referenceId
        : task.id.slice(0, 8).toUpperCase(),
    // lp
    lpToken: asAddress(meta.token ?? payload.token),
    lpAmount: toBigIntValue(meta.amount) ?? toBigIntValue(payload.amount),
    lpShares: undefined,
    // extra
    backendTaskId: task.id,
    backendStatus: task.status,
  } as UnifiedHistoryItem & { backendTaskId: string; backendStatus: string };
}

interface UseBackendTaskHistoryOptions {
  walletAddress?: string;
  type?: string;
  limit?: number;
  enabled?: boolean;
  /** polling interval ms (default 30s) */
  refetchInterval?: number;
}

/**
 * Fetch task history from backend API.
 * Returns unified history items suitable for TransactionHistory component.
 */
export function useBackendTaskHistory(
  options: UseBackendTaskHistoryOptions = {}
) {
  const {
    walletAddress,
    type,
    limit = 50,
    enabled = true,
    refetchInterval = 30_000,
  } = options;

  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (walletAddress) params.set("wallet", walletAddress);
  params.set("limit", String(limit));

  const { data, isLoading, isError, refetch } = useQuery<
    BackendTaskListResponse,
    Error
  >({
    queryKey: ["backend-task-history", walletAddress, type, limit],
    queryFn: () =>
      backendFetch<BackendTaskListResponse>(`/tasks?${params.toString()}`),
    enabled,
    refetchInterval,
    staleTime: 15_000,
  });

  const items: UnifiedHistoryItem[] = (data?.items ?? [])
    .map(backendTaskToHistoryItem)
    .filter((item): item is UnifiedHistoryItem => item !== null);

  return { items, total: data?.total ?? 0, isLoading, isError, refetch };
}
