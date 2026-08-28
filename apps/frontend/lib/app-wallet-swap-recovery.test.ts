import { describe, expect, it, vi } from "vitest";

import { appWalletSwapExecutionState, clearAppWalletSwapRecovery, readAppWalletSwapRecovery, writeAppWalletSwapRecovery } from "./app-wallet-swap-recovery";
import type { AppWalletXylonetOperationResponse } from "./app-wallet-swap-service";

const walletAddress = "0x1111111111111111111111111111111111111111";
const operation = { operationId: "11111111-1111-4111-8111-111111111111", circleWalletId: "wallet-a", walletAddress, lifecycleStage: "swap_submitted" } as AppWalletXylonetOperationResponse;

function storage() {
  const values = new Map<string, string>();
  return { values, api: { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => values.set(key, value)), removeItem: vi.fn((key: string) => values.delete(key)) } as unknown as Storage };
}

describe("App Wallet Swap recovery scope", () => {
  it("restores only the exact Circle wallet and sender", () => {
    const store = storage();
    writeAppWalletSwapRecovery(store.api, operation);
    expect(readAppWalletSwapRecovery(store.api, { circleWalletId: "wallet-a", walletAddress })).toMatchObject({ operationId: operation.operationId });
    expect(readAppWalletSwapRecovery(store.api, { circleWalletId: "wallet-b", walletAddress })).toBeNull();
    expect(readAppWalletSwapRecovery(store.api, { circleWalletId: "wallet-a", walletAddress: "0x2222222222222222222222222222222222222222" })).toBeNull();
  });

  it("clears only the active scoped pointer on Start Over", () => {
    const store = storage();
    writeAppWalletSwapRecovery(store.api, operation);
    clearAppWalletSwapRecovery(store.api, { circleWalletId: "wallet-a", walletAddress });
    expect(readAppWalletSwapRecovery(store.api, { circleWalletId: "wallet-a", walletAddress })).toBeNull();
  });

  it("keeps timeout unresolved while failure and success are mutually exclusive", () => {
    expect(appWalletSwapExecutionState({ ...operation, lifecycleStage: "timed_out" })).toBe("timeout");
    expect(appWalletSwapExecutionState({ ...operation, lifecycleStage: "failed", terminalStatus: "failed" })).toBe("failed");
    expect(appWalletSwapExecutionState({ ...operation, lifecycleStage: "completed", terminalStatus: "confirmed", swapTransactionHash: `0x${"a".repeat(64)}`, verifiedActualOutput: "1" })).toBe("success");
  });
});
