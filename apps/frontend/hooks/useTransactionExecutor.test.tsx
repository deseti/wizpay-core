import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTransactionExecutor } from "./useTransactionExecutor";

const fixture = vi.hoisted(() => ({
  switchChain: vi.fn(),
  write: vi.fn(),
  prepare: vi.fn(),
  refetch: vi.fn(),
  chainId: 5042,
  address: "0x1000000000000000000000000000000000000001",
}));
vi.mock("@/components/providers/external-wallet-context", () => ({
  useExternalWallet: () => ({
    activeWalletAddress: fixture.address,
    activeWalletChainId: fixture.chainId,
  }),
}));
vi.mock("wagmi", async (original) => ({
  ...(await original<typeof import("wagmi")>()),
  usePublicClient: () => ({ getBlockNumber: async () => 100n }),
  useWalletClient: () => ({ data: {}, refetch: fixture.refetch }),
  useSwitchChain: () => ({ switchChainAsync: fixture.switchChain }),
}));
vi.mock("@/lib/web3-transactions", () => ({
  writeContractTransaction: fixture.write,
}));
vi.mock("@/lib/execution-intent", () => ({
  prepareWalletExecutionIntent: fixture.prepare,
}));

const input = {
  abi: [],
  contractAddress: "0x3600000000000000000000000000000000000000" as const,
  functionName: "transfer",
  args: ["0x2000000000000000000000000000000000000002", 10000n],
  refId: "synthetic-send",
  executionIntentId: "synthetic-intent",
  idempotencyKey: "synthetic-key",
};

describe("external Send/Payroll transaction authority boundary", () => {
  beforeEach(() => {
    fixture.chainId = 5042;
    fixture.refetch.mockResolvedValue({ data: {} });
    fixture.prepare.mockResolvedValue({});
  });
  it("propagates user refusal without a hash, success, verification or fallback execution", async () => {
    fixture.write.mockRejectedValue(
      Object.assign(new Error("User rejected request"), { code: 4001 }),
    );
    const onWalletPrepared = vi.fn();
    const { result } = renderHook(useTransactionExecutor);
    await expect(
      result.current.executeTransaction({ ...input, onWalletPrepared }),
    ).rejects.toMatchObject({ code: 4001 });
    expect(onWalletPrepared).toHaveBeenCalledTimes(1);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledTimes(1);
    expect(fixture.write).toHaveBeenCalledWith(
      expect.objectContaining({
        account: fixture.address,
        address: input.contractAddress,
        functionName: "transfer",
        chain: expect.objectContaining({ id: 5042 }),
      }),
    );
  });
  it("refused network switch never prepares an intent or requests a financial signature", async () => {
    fixture.chainId = 1;
    fixture.switchChain.mockRejectedValue(new Error("User rejected switch"));
    const { result } = renderHook(useTransactionExecutor);
    await expect(result.current.executeTransaction(input)).rejects.toThrow(
      "Network switch was rejected in your wallet.",
    );
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("failed durable lease preparation stops before wallet submission", async () => {
    fixture.prepare.mockRejectedValue(new Error("Lease unavailable"));
    const { result } = renderHook(useTransactionExecutor);
    await expect(result.current.executeTransaction(input)).rejects.toThrow(
      "Lease unavailable",
    );
    expect(fixture.write).not.toHaveBeenCalled();
  });
});
