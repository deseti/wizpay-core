export interface PayrollFxAllocationInput {
  recipientLineId: string;
  recipientIndex: number;
  recipientAddress: string;
  destinationTokenAddress: string;
  requestedWeightBaseUnits: string;
}

export interface PayrollFxAllocationResult extends PayrollFxAllocationInput {
  allocatedAmountBaseUnits: string;
  deterministicRank: number;
}

export interface PayrollFxAllocationPlan {
  settledBudgetBaseUnits: string;
  totalRequestedWeightBaseUnits: string;
  totalAllocatedBaseUnits: string;
  dustBaseUnits: string;
  allocations: PayrollFxAllocationResult[];
}
