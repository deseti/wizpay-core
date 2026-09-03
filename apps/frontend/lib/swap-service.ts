import { backendFetch } from "@/lib/backend-api";

export interface LiquidityTaskPlan {
  taskId: string;
  unitId: string;
  operation: "add" | "remove";
  token: string;
  amount: string;
}

/**
 * Create a liquidity task in the backend and receive the execution plan.
 */
export async function initLiquidityTask(params: {
  operation: "add" | "remove";
  token: string;
  amount: string;
  walletAddress: string;
}): Promise<LiquidityTaskPlan> {
  return backendFetch<LiquidityTaskPlan>("/tasks/liquidity/init", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Report the on-chain liquidity result back to the backend.
 */
export async function reportLiquidityResult(
  taskId: string,
  unitId: string,
  result: { status: "SUCCESS" | "FAILED"; txHash?: string; error?: string }
) {
  return backendFetch(`/tasks/${taskId}/units/${unitId}/report`, {
    method: "POST",
    body: JSON.stringify(result),
  });
}
