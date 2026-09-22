"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { backendFetch } from "@/lib/backend-api";
import type {
  ActivityDto,
  ActivityListResponse,
  UnifiedHistoryItem,
} from "@/lib/types";

function sessionScope(token?: string | null) {
  if (!token?.trim()) return "unauthenticated";
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `circle:${token.length}:${(hash >>> 0).toString(16)}`;
}

function address(value: string | null): Address | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Address)
    : undefined;
}

function units(value: string | null): bigint | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

export function activityDtoToHistoryItem(
  item: ActivityDto,
): UnifiedHistoryItem {
  const inputAddress = address(item.inputTokenAddress);
  const outputAddress = address(item.outputTokenAddress);
  return {
    id: item.id,
    type: item.type,
    direction: item.direction,
    status: item.status,
    txHash: (/^0x[0-9a-fA-F]{64}$/.test(item.txHash ?? "")
      ? item.txHash
      : "0x") as Hex,
    blockNumber: 0n,
    timestampMs: Date.parse(item.occurredAt ?? item.createdAt),
    chainId: item.chainId ?? undefined,
    tokenIn: inputAddress ?? outputAddress,
    tokenOut: outputAddress,
    tokenSymbol: item.inputTokenSymbol ?? item.outputTokenSymbol ?? undefined,
    amountDisplay: item.inputAmount ?? item.outputAmount ?? undefined,
    totalAmountIn: units(item.inputAmount ?? item.outputAmount),
    totalAmountOut: units(item.outputAmount),
    totalFees: units(item.feeAmount),
    lpToken: inputAddress ?? outputAddress,
    lpAmount: units(item.inputAmount ?? item.outputAmount),
    referenceId:
      typeof item.metadata?.referenceId === "string"
        ? item.metadata.referenceId
        : item.sourceReferenceId,
    transactionHashes: Array.isArray(item.metadata?.transactionHashes)
      ? item.metadata.transactionHashes.filter(
          (value): value is Hex =>
            typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
        )
      : undefined,
    tokenTotals:
      item.metadata?.tokenTotals &&
      typeof item.metadata.tokenTotals === "object" &&
      !Array.isArray(item.metadata.tokenTotals)
        ? Object.fromEntries(
            Object.entries(item.metadata.tokenTotals).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string" && /^\d+$/.test(entry[1]),
            ),
          )
        : undefined,
    counterparty: item.counterparty ?? undefined,
    recipientCount:
      typeof item.metadata?.transactionCount === "number"
        ? item.metadata.transactionCount
        : undefined,
  };
}

export function useUnifiedActivity(
  options: {
    userToken?: string | null;
    enabled?: boolean;
    limit?: number;
    type?: string;
    status?: string;
    refetchInterval?: number;
  } = {},
) {
  const queryClient = useQueryClient();
  const generation = useRef(0);
  const startedScopes = useRef(new Set<string>());
  const {
    userToken,
    enabled = true,
    limit = 50,
    type,
    status,
    refetchInterval = 60_000,
  } = options;
  const authenticated = Boolean(userToken?.trim());
  const params = new URLSearchParams({ limit: String(limit) });
  if (type) params.set("type", type);
  if (status) params.set("status", status);
  const scope = sessionScope(userToken);
  const [trackedScope, setTrackedScope] = useState(scope);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<Error | null>(null);
  const [syncAttempt, setSyncAttempt] = useState(0);
  if (trackedScope !== scope) {
    setTrackedScope(scope);
    setSyncError(null);
  }
  const syncComplete = readyScope === scope;
  const canRead = enabled && authenticated && syncComplete;
  const queryKey = [
      "unified-activity",
      scope,
      type ?? "all",
      status ?? "all",
      limit,
    ] as const;
  const query = useQuery<ActivityListResponse, Error>({
    queryKey,
    queryFn: () =>
      backendFetch(`/activities?${params.toString()}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      }),
    enabled: canRead,
    refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });
  useEffect(() => {
    queryClient.removeQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === "unified-activity" &&
        query.queryKey[1] !== scope,
    });
  }, [queryClient, scope]);
  useEffect(() => {
    if (!enabled || !authenticated || !userToken || readyScope === scope) return;
    if (startedScopes.current.has(scope)) return;
    const current = generation.current + 1;
    generation.current = current;
    startedScopes.current.add(scope);
    void backendFetch<{
      status: "synced" | "throttled" | "in_flight" | "failed";
    }>("/activities/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((summary) => {
        if (generation.current !== current) return;
        if (summary.status === "failed") {
          throw new Error("Activity synchronization is temporarily unavailable.");
        }
        setReadyScope(scope);
        return queryClient.invalidateQueries({
          queryKey: ["unified-activity", scope],
        });
      })
      .catch((cause: unknown) => {
        startedScopes.current.delete(scope);
        if (generation.current !== current) return;
        setSyncError(
          cause instanceof Error
            ? cause
            : new Error("Activity synchronization is temporarily unavailable."),
        );
      });
    return () => {
      if (generation.current === current) generation.current += 1;
      startedScopes.current.delete(scope);
    };
  }, [authenticated, enabled, queryClient, readyScope, scope, syncAttempt, userToken]);
  const retry = () => {
    startedScopes.current.delete(scope);
    setSyncError(null);
    setReadyScope(null);
    setSyncAttempt((value) => value + 1);
  };
  return {
    items: canRead
      ? (query.data?.items ?? []).map(activityDtoToHistoryItem)
      : [],
    nextCursor: canRead ? (query.data?.nextCursor ?? null) : null,
    isLoading: enabled && authenticated && (!syncComplete || query.isLoading) && !syncError,
    isError: Boolean(syncError) || query.isError,
    error: syncError ?? query.error ?? null,
    refetch: query.refetch,
    retry,
  };
}
