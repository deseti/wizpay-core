import { useMemo } from "react";
import { type Address, type Hex } from "viem";

import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { sameAddress } from "@/lib/wizpay";
import type { HistoryItem, UnifiedHistoryItem } from "@/lib/types";
import { useBackendTaskHistory } from "@/hooks/useBackendTaskHistory";
import { useAnsActivityHistory } from "@/src/features/ans/hooks/useAnsActivityHistory";

function isValidTxHash(value: string): value is Hex {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

export function useWizPayHistory({
  activeToken,
  refetchCb: _refetchCb,
}: {
  activeToken: { address: Address };
  refetchCb: () => void;
}) {
  const { isConnected, walletAddress } = useActiveWalletAddress();
  // Backend task history only (no on-chain log scans).
  const { items: backendItems, isLoading: backendLoading } = useBackendTaskHistory({
    // Keep history complete while older tasks may not carry initiator wallet metadata.
    // Once all task types persist walletAddress consistently, this can be re-enabled.
    walletAddress: undefined,
    limit: 50,
    enabled: isConnected,
  });
  const ansItems = useAnsActivityHistory(walletAddress);

  const unifiedHistory = useMemo<UnifiedHistoryItem[]>(() => {
    const seen = new Set<string>();
    const deduped = [...ansItems, ...backendItems].filter((item) => {
      const key =
        item.txHash && item.txHash !== "0x"
          ? `tx:${item.txHash.toLowerCase()}`
          : `fallback:${item.type}:${item.referenceId ?? ""}:${item.timestampMs}`;

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped.sort((a, b) => b.timestampMs - a.timestampMs);
  }, [ansItems, backendItems]);

  const history = useMemo<HistoryItem[]>(() => {
    return unifiedHistory
      .filter((item): item is UnifiedHistoryItem & {
        tokenIn: Address;
        tokenOut: Address;
        totalAmountIn: bigint;
        totalAmountOut: bigint;
        totalFees: bigint;
        recipientCount: number;
        referenceId: string;
      } => {
        return (
          item.type === "payroll" &&
          Boolean(item.tokenIn) &&
          Boolean(item.tokenOut) &&
          item.totalAmountIn !== undefined &&
          item.totalAmountOut !== undefined &&
          item.totalFees !== undefined &&
          item.recipientCount !== undefined &&
          Boolean(item.referenceId)
        );
      })
      .map((item) => ({
        contractAddress: activeToken.address,
        tokenIn: item.tokenIn,
        tokenOut: item.tokenOut,
        totalAmountIn: item.totalAmountIn,
        totalAmountOut: item.totalAmountOut,
        totalFees: item.totalFees,
        recipientCount: item.recipientCount,
        referenceId: item.referenceId,
        txHash: isValidTxHash(item.txHash) ? item.txHash : ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex),
        blockNumber: item.blockNumber,
        timestampMs: item.timestampMs,
      }));
  }, [activeToken.address, unifiedHistory]);

  const totalRouted = useMemo(() => {
    return history.reduce((total, item) => {
      if (!sameAddress(item.tokenIn, activeToken.address)) return total;
      return total + item.totalAmountIn;
    }, 0n);
  }, [activeToken.address, history]);

  return {
    history,
    unifiedHistory,
    totalRouted,
    historyLoading: backendLoading,
  };
}
