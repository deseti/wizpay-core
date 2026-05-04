"use client";

import { useMemo } from "react";
import { formatUnits, type Address } from "viem";
import { TOKEN_BY_ADDRESS } from "@/constants/erc20";

import {
  groupPayrollByMonth,
  computeTokenAllocation,
  getUniqueTokens,
} from "@/lib/dashboard-utils";
import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { usePayrollHistory } from "@/hooks/usePayrollHistory";

/**
 * Orchestrator hook for the payroll overview dashboard.
 * Combines on-chain event data, token balances, and employee payments
 * into a unified state object for the dashboard page and components.
 */
export function usePayrollData() {
  const { walletAddress } = useActiveWalletAddress();

  // Token balances
  const {
    balances: tokenBalances,
    isLoading: balancesLoading,
    isError: balancesError,
  } = useTokenBalances();

  // Backend-driven payroll history (batch events + employee payments)
  const {
    events,
    employeePayments,
    isLoading: historyLoading,
    isError: historyError,
    error: historyQueryError,
  } = usePayrollHistory();

  // ── Computed stats ──

  const totalPayroll = useMemo(
    () =>
      events.reduce((sum, e) => {
        const decimals =
          TOKEN_BY_ADDRESS.get(e.tokenIn.toLowerCase())?.decimals ?? 6;
        return sum + Number(formatUnits(e.totalAmountIn, decimals));
      }, 0),
    [events]
  );

  const totalRecipientCount = useMemo(
    () => events.reduce((sum, e) => sum + e.recipientCount, 0),
    [events]
  );

  const uniqueEmployees = useMemo(() => {
    const addrs = new Set<string>();
    for (const p of employeePayments) {
      if (p.employee !== "Multiple Recipients") {
        addrs.add(p.employee.toLowerCase());
      }
    }
    // If no individual payments are resolved, use aggregate recipient count
    return addrs.size > 0 ? addrs.size : totalRecipientCount;
  }, [employeePayments, totalRecipientCount]);

  const averagePayment = useMemo(
    () =>
      totalRecipientCount > 0 ? totalPayroll / totalRecipientCount : 0,
    [totalPayroll, totalRecipientCount]
  );

  const tokensDistributed = useMemo(() => getUniqueTokens(events), [events]);

  const monthlyData = useMemo(() => groupPayrollByMonth(events), [events]);

  const tokenAllocation = useMemo(
    () => computeTokenAllocation(events),
    [events]
  );

  const batchCount = events.length;

  // ── Aggregated loading / error state ──
  const isLoading = historyLoading || balancesLoading;
  const isError = historyError || balancesError;
  const error = historyQueryError;
  const hasData = events.length > 0;

  return {
    // Wallet
    walletAddress,

    // Stats
    totalPayroll,
    uniqueEmployees,
    averagePayment,
    tokensDistributed,
    batchCount,

    // Token balances
    tokenBalances,

    // Charts
    monthlyData,
    tokenAllocation,

    // Table data
    employeePayments,

    // Raw events
    events,

    // State
    isLoading,
    isError,
    error,
    hasData,
  };
}
