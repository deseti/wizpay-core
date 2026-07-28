import type { PayrollFxAllocationResult } from './payroll-fx-allocation.types';

export const PAYROLL_FX_ALLOCATION_ALGORITHM_VERSION = 'largest-remainder-v1';

export interface PayrollFxPayoutPlan {
  id: string;
  operationId: string;
  taskId: string;
  executionProvider: 'stablefx';
  network: string;
  tokenAddress: string;
  tokenDecimals: number;
  sourceWalletAddress: string;
  settledBudgetBaseUnits: string;
  totalRequestedWeightBaseUnits: string;
  totalAllocatedBaseUnits: string;
  dustBaseUnits: string;
  allocationAlgorithmVersion: string;
  immutableInputHash: string;
  status: 'planned';
  createdAt: Date;
  allocations: Array<
    PayrollFxAllocationResult & {
      id: string;
      planId: string;
      status: 'planned';
      createdAt: Date;
    }
  >;
}

export interface CreatePayrollFxPayoutPlanInput {
  operationId: string;
  taskId: string;
  executionProvider: 'stablefx';
  network: string;
  tokenAddress: string;
  tokenDecimals: number;
  sourceWalletAddress: string;
  settledBudgetBaseUnits: string;
  totalRequestedWeightBaseUnits: string;
  totalAllocatedBaseUnits: string;
  dustBaseUnits: string;
  allocationAlgorithmVersion: string;
  immutableInputHash: string;
  allocations: PayrollFxAllocationResult[];
}
