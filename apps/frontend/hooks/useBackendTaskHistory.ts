"use client";

import { useQuery } from "@tanstack/react-query";
import { backendFetch } from "@/lib/backend-api";
import type {
  BackendTask,
  BackendTaskListResponse,
  HistoryActionType,
  UnifiedHistoryItem,
} from "@/lib/types";

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

/** Convert a backend task to a UnifiedHistoryItem for display */
export function backendTaskToHistoryItem(
  task: BackendTask
): UnifiedHistoryItem | null {
  const txHash =
    (task.units[0]?.txHash as `0x${string}` | null) ??
    (task.result?.txHash as `0x${string}` | null);

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

  return {
    type,
    txHash: txHash ?? "0x",
    blockNumber: 0n,
    timestampMs: createdAt,
    // payroll
    tokenIn: (meta.tokenIn ?? payload.tokenIn ?? meta.sourceToken ?? payload.sourceToken) as `0x${string}` | undefined,
    tokenOut: (meta.tokenOut ?? payload.tokenOut) as `0x${string}` | undefined,
    totalAmountIn: meta.amountIn || payload.amountIn
      ? BigInt(String(meta.amountIn ?? payload.amountIn ?? "0"))
      : undefined,
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
    lpToken: (meta.token ?? payload.token) as `0x${string}` | undefined,
    lpAmount: meta.amount || payload.amount
      ? BigInt(String(meta.amount ?? payload.amount ?? "0"))
      : undefined,
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
