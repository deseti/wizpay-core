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
    referenceId: item.sourceReferenceId,
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
  const synchronizedScopes = useRef(new Set<string>());
  const [readSessionToken, setReadSessionToken] = useState<string | null>(null);
  const {
    userToken,
    enabled = true,
    limit = 50,
    type,
    status,
    refetchInterval = 60_000,
  } = options;
  const authenticated = Boolean(userToken?.trim());
  const canRead = enabled && authenticated && Boolean(readSessionToken);
  const params = new URLSearchParams({ limit: String(limit) });
  if (type) params.set("type", type);
  if (status) params.set("status", status);
  const scope = sessionScope(userToken);
  const readSessionScope = sessionScope(readSessionToken);
  const queryKey = [
      "unified-activity",
      scope,
      readSessionScope,
      type ?? "all",
      status ?? "all",
      limit,
    ] as const;
  const query = useQuery<ActivityListResponse, Error>({
    queryKey,
    queryFn: () =>
      backendFetch(`/activities?${params.toString()}`, {
        headers: { Authorization: `Bearer ${readSessionToken}` },
      }),
    enabled: canRead,
    refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 15_000,
  });
  useEffect(() => {
    setReadSessionToken(null);
  }, [scope]);
  useEffect(() => {
    if (!enabled || !authenticated || !userToken || synchronizedScopes.current.has(scope)) return;
    synchronizedScopes.current.add(scope);
    let cancelled = false;
    void backendFetch<{
      status: "synced" | "throttled" | "in_flight" | "failed";
      readSessionToken: string;
    }>("/activities/sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    })
      .then((summary) => {
        if (cancelled) return;
        setReadSessionToken(summary.readSessionToken);
        return queryClient.invalidateQueries({
          queryKey: ["unified-activity", scope],
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authenticated, enabled, queryClient, scope, userToken]);
  return {
    items: canRead
      ? (query.data?.items ?? []).map(activityDtoToHistoryItem)
      : [],
    nextCursor: canRead ? (query.data?.nextCursor ?? null) : null,
    isLoading: enabled && authenticated && (!readSessionToken || query.isLoading),
    isError: query.isError,
    refetch: query.refetch,
  };
}
