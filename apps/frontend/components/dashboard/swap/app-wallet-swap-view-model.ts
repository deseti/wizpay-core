import type {
  AppWalletSwapOperationResponse,
  AppWalletSwapProvider,
} from "@/lib/app-wallet-swap-service";
import {
  formatUserSwapQuoteAmount,
  getUserSwapExpectedOutputDisplay,
} from "@/lib/user-swap-quote-parser";

export type AppWalletSwapPhase =
  | "confirm_deposit"
  | "processing_swap"
  | "receiving_payout"
  | "recovering"
  | "refunded"
  | "completed"
  | "failed";

export function getAppWalletQuoteProvider(
  quote: { provider?: unknown } | null,
): AppWalletSwapProvider | undefined {
  return quote?.provider === "stablefx" || quote?.provider === "swapkit"
    ? quote.provider
    : undefined;
}

export function getOperationExpectedOutput(
  operation: AppWalletSwapOperationResponse,
) {
  return getUserSwapExpectedOutputDisplay(
    {
      expectedOutput: operation.expectedOutput,
      rawQuote: operation.rawQuote,
    },
    operation.tokenOut,
  );
}

export function isAppWalletExecutionStatus(
  status: AppWalletSwapOperationResponse["status"],
) {
  return [
    "stablefx_quote_requested",
    "stablefx_trade_created",
    "stablefx_contract_ready",
    "stablefx_funded",
    "stablefx_settled_to_treasury",
    "treasury_swap_pending",
    "treasury_swap_submitted",
    "treasury_swap_confirmed",
    "payout_pending",
    "payout_submitted",
    "payout_confirmed",
  ].includes(status);
}

export function canExecuteAppWalletOperation(
  operation: AppWalletSwapOperationResponse,
) {
  return (
    operation.status === "deposit_confirmed" ||
    operation.status === "execution_failed" ||
    isAppWalletExecutionStatus(operation.status)
  );
}

export function canRequestAppWalletRefund(
  operation: AppWalletSwapOperationResponse,
) {
  return (
    operation.operationId.trim().length > 0 &&
    [
      "execution_recovery_required",
      "execution_failed",
      "refund_pending",
      "refund_submitted",
    ].includes(operation.status)
  );
}

export function isAppWalletRefundStatus(
  status: AppWalletSwapOperationResponse["status"],
) {
  return [
    "execution_recovery_required",
    "refund_pending",
    "refund_submitted",
    "refunded",
  ].includes(status);
}

export function getRefundActionLabel(
  status: AppWalletSwapOperationResponse["status"],
) {
  switch (status) {
    case "refund_pending":
      return "Continue refund recovery";
    case "refund_submitted":
      return "Check refund status";
    default:
      return "Request refund";
  }
}

export function getAppWalletOperationMessage(
  operation: AppWalletSwapOperationResponse,
) {
  switch (operation.status) {
    case "deposit_confirmed":
    case "stablefx_quote_requested":
    case "stablefx_trade_created":
    case "stablefx_contract_ready":
    case "stablefx_funded":
    case "stablefx_settled_to_treasury":
    case "treasury_swap_pending":
    case "treasury_swap_submitted":
    case "treasury_swap_confirmed":
    case "payout_pending":
      return "WizPay is securely settling your swap. This can take a few minutes.";
    case "payout_submitted":
    case "payout_confirmed":
      return "Your output token is being sent back to your App Wallet.";
    case "completed":
      return `Swap completed. ${operation.tokenOut} is in your App Wallet.`;
    case "execution_failed":
      return "Something went wrong during settlement. You can retry the status check.";
    case "execution_recovery_required":
      return "Settlement stopped safely. This operation needs recovery or a verified refund.";
    case "refund_pending":
    case "refund_submitted":
      return `Your verified ${operation.tokenIn} deposit is being returned.`;
    case "refunded":
      return `Your verified ${operation.tokenIn} deposit was returned.`;
    case "deposit_submitted":
      return "Deposit received. Waiting for network confirmation.";
    default:
      return "Approve the deposit from your App Wallet to start the swap.";
  }
}

export function getAppWalletSwapPhase(
  operation: AppWalletSwapOperationResponse | null,
): AppWalletSwapPhase {
  if (!operation) return "confirm_deposit";
  switch (operation.status) {
    case "awaiting_user_deposit":
      return "confirm_deposit";
    case "deposit_submitted":
    case "deposit_confirmed":
    case "stablefx_quote_requested":
    case "stablefx_trade_created":
    case "stablefx_contract_ready":
    case "stablefx_funded":
    case "stablefx_settled_to_treasury":
    case "treasury_swap_pending":
    case "treasury_swap_submitted":
    case "treasury_swap_confirmed":
    case "payout_pending":
      return "processing_swap";
    case "payout_submitted":
    case "payout_confirmed":
      return "receiving_payout";
    case "completed":
      return "completed";
    case "execution_failed":
      return "failed";
    case "execution_recovery_required":
    case "refund_pending":
    case "refund_submitted":
      return "recovering";
    case "refunded":
      return "refunded";
    default:
      return "confirm_deposit";
  }
}

export function getPhaseTitle(phase: AppWalletSwapPhase): string {
  switch (phase) {
    case "confirm_deposit":
      return "Confirm swap";
    case "processing_swap":
      return "Processing your swap";
    case "receiving_payout":
      return "Sending funds to your wallet";
    case "recovering":
      return "Refund recovery";
    case "refunded":
      return "Refund confirmed";
    case "completed":
      return "Swap completed";
    case "failed":
      return "Swap needs attention";
  }
}

export function getPhaseDescription(
  phase: AppWalletSwapPhase,
  operation: AppWalletSwapOperationResponse | null,
): string {
  switch (phase) {
    case "confirm_deposit":
      return "Approve the deposit from your App Wallet to start the swap.";
    case "processing_swap":
      return "WizPay is securely settling your swap. This can take a few minutes.";
    case "receiving_payout":
      return "Your output token is being sent back to your App Wallet.";
    case "recovering":
      if (operation?.status === "execution_recovery_required") {
        return "Settlement stopped safely. You can ask WizPay to recover the verified deposit when backend and provider safety checks allow it.";
      }
      if (operation?.status === "refund_pending") {
        return "Refund recovery is prepared. Continue only when you are ready for the backend to safely resume the idempotent refund.";
      }
      return "The refund was submitted and is waiting for transaction and on-chain confirmation.";
    case "refunded":
      return operation?.refundAmount
        ? `${formatUserSwapQuoteAmount(operation.refundAmount, operation.tokenIn) ?? operation.refundAmount} was confirmed returned to your App Wallet.`
        : "The verified deposit refund was confirmed in your App Wallet.";
    case "completed":
      return operation
        ? `You received ${formatUserSwapQuoteAmount(operation.payoutAmount ?? operation.treasurySwapActualOutput, operation.tokenOut) ?? operation.tokenOut} in your App Wallet.`
        : "Swap is complete.";
    case "failed":
      return "Something went wrong during settlement. You can retry the status check.";
  }
}
