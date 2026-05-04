"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

import { useActiveWalletAddress } from "@/hooks/useActiveWalletAddress";
import { backendFetch } from "@/lib/backend-api";
import type { EmployeePayment, PayrollEvent } from "@/lib/dashboard-utils";
import type {
  BackendPayrollHistoryEvent,
  BackendPayrollHistoryResponse,
  BackendTaskEmployeeBreakdownItem,
} from "@/lib/types";

interface PayrollHistoryResult {
  events: PayrollEvent[];
  employeePayments: EmployeePayment[];
}

export function usePayrollHistory() {
  const { walletAddress } = useActiveWalletAddress();

  const query = useQuery({
    queryKey: ["payroll-history", walletAddress ?? "disconnected"],
    enabled: Boolean(walletAddress),
    staleTime: 60_000,
    queryFn: async (): Promise<PayrollHistoryResult> => {
      const response = await backendFetch<BackendPayrollHistoryResponse>(
        `/tasks/payroll/history?wallet=${encodeURIComponent(walletAddress!)}`
      );

      return {
        events: response.events.map(mapPayrollHistoryEvent),
        employeePayments: response.employeePayments.map(mapEmployeePayment),
      };
    },
  });

  return {
    events: query.data?.events ?? [],
    employeePayments: query.data?.employeePayments ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

function mapPayrollHistoryEvent(event: BackendPayrollHistoryEvent): PayrollEvent {
  return {
    txHash: event.txHash,
    blockNumber: BigInt(event.blockNumber),
    timestampMs: event.timestampMs,
    tokenIn: event.tokenIn as Address,
    tokenOut: event.tokenOut as Address,
    totalAmountIn: BigInt(event.totalAmountIn),
    totalAmountOut: BigInt(event.totalAmountOut),
    totalFees: BigInt(event.totalFees),
    recipientCount: event.recipientCount,
    referenceId: event.referenceId,
  };
}

function mapEmployeePayment(
  payment: BackendTaskEmployeeBreakdownItem
): EmployeePayment {
  return {
    date: payment.date,
    employee: payment.employee,
    status: "Confirmed",
    amount: BigInt(payment.amount),
    tokenSymbol: payment.tokenSymbol,
    tokenDecimals: payment.tokenDecimals,
    txHash: payment.txHash,
  };
}