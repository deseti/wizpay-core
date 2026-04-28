import { backendFetch } from "@/lib/backend-api";

export interface SwapTaskPlan {
  taskId: string;
  unitId: string;
  referenceId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  recipient: string;
}

export interface LiquidityTaskPlan {
  taskId: string;
  unitId: string;
  operation: "add" | "remove";
  token: string;
  amount: string;
}

/**
 * Create a swap task in the backend and receive the execution plan.
 * The referenceId returned must be used in the on-chain batchRouteAndPay call.
 */
export async function initSwapTask(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  recipient: string;
}): Promise<SwapTaskPlan> {
  return backendFetch<SwapTaskPlan>("/tasks/swap/init", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Report the on-chain swap result back to the backend.
 */
export async function reportSwapResult(
  taskId: string,
  unitId: string,
  result: { status: "SUCCESS" | "FAILED"; txHash?: string; error?: string }
) {
  return backendFetch(`/tasks/${taskId}/units/${unitId}/report`, {
    method: "POST",
    body: JSON.stringify(result),
  });
}

/**
 * Create a liquidity task in the backend and receive the execution plan.
 */
export async function initLiquidityTask(params: {
  operation: "add" | "remove";
  token: string;
  amount: string;
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
