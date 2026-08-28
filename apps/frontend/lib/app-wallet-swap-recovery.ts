import { getAddress, isAddress, type Address } from "viem";

import type { AppWalletXylonetOperationResponse } from "./app-wallet-swap-service";

const PREFIX = "wizpay.app-wallet-swap.recovery.v1";

export type AppWalletSwapRecoveryPointer = {
  operationId: string;
  circleWalletId: string;
  walletAddress: Address;
};

export function appWalletSwapRecoveryKey(scope: Omit<AppWalletSwapRecoveryPointer, "operationId">) {
  return `${PREFIX}:${scope.circleWalletId}:${scope.walletAddress.toLowerCase()}`;
}

export function writeAppWalletSwapRecovery(storage: Storage | undefined, operation: AppWalletXylonetOperationResponse) {
  if (!storage || !isAddress(operation.walletAddress)) return;
  const pointer: AppWalletSwapRecoveryPointer = {
    operationId: operation.operationId,
    circleWalletId: operation.circleWalletId,
    walletAddress: getAddress(operation.walletAddress),
  };
  storage.setItem(appWalletSwapRecoveryKey(pointer), JSON.stringify(pointer));
}

export function readAppWalletSwapRecovery(
  storage: Storage | undefined,
  scope: Omit<AppWalletSwapRecoveryPointer, "operationId"> | null,
) {
  if (!storage || !scope) return null;
  try {
    const raw = storage.getItem(appWalletSwapRecoveryKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppWalletSwapRecoveryPointer>;
    if (
      typeof parsed.operationId !== "string" ||
      parsed.circleWalletId !== scope.circleWalletId ||
      !isAddress(parsed.walletAddress ?? "") ||
      getAddress(parsed.walletAddress as string) !== getAddress(scope.walletAddress)
    ) return null;
    return parsed as AppWalletSwapRecoveryPointer;
  } catch {
    return null;
  }
}

export function clearAppWalletSwapRecovery(storage: Storage | undefined, scope: Omit<AppWalletSwapRecoveryPointer, "operationId">) {
  storage?.removeItem(appWalletSwapRecoveryKey(scope));
}

export function appWalletSwapExecutionState(operation: AppWalletXylonetOperationResponse | null) {
  if (!operation) return "idle" as const;
  if (operation.terminalStatus === "confirmed" && operation.lifecycleStage === "completed" && operation.swapTransactionHash && operation.verifiedActualOutput) return "success" as const;
  if (operation.terminalStatus && operation.terminalStatus !== "confirmed") return "failed" as const;
  if (operation.lifecycleStage === "timed_out" || /timed out without proving/i.test(operation.failureReason ?? "")) return "timeout" as const;
  return "pending" as const;
}
