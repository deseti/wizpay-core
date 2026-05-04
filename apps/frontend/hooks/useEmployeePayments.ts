"use client";

import { usePayrollHistory } from "@/hooks/usePayrollHistory";

/**
 * Read employee-level payroll payments from the wallet-scoped payroll history endpoint.
 *
 * The browser no longer scans contract events or transaction receipts.
 */
export function useEmployeePayments() {
  const query = usePayrollHistory();

  return {
    payments: query.employeePayments,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
