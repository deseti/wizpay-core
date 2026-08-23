import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WIZPAY_BATCH_PAYMENT_ROUTED_EVENT } from "@/constants/abi";
import { WIZPAY_ADDRESS } from "@/constants/addresses";
import {
  beginExternalPayrollBatchSubmission,
  getRecoveredExternalPayrollBatch,
  recordExternalPayrollBatchConfirmation,
  runExternalPayrollXylonetSwap,
  type ExternalPayrollXylonetActions,
  type ExternalPayrollXylonetBinding,
} from "@/lib/external-payroll-xylonet";
import { WIZPAY_SWAP_EXECUTOR_V2_ABI } from "@/lib/external-xylonet-swap";
import type { UserSwapQuoteResponse } from "@/lib/user-swap-service";

const wallet = "0x90ab859240b941eaf0cbcbf42df5086e0ad54147" as Address;
const router = "0x73742278c31a76dBb0D2587d03ef92E6E2141023" as Address;
const executor = "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed" as Address;
const usdc = "0x3600000000000000000000000000000000000000" as Address;
const eurc = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address;
const approvalHash = `0x${"a".repeat(64)}` as Hex;
const swapHash = `0x${"b".repeat(64)}` as Hex;
const payrollHash = `0x${"c".repeat(64)}` as Hex;

function binding(
  tokenIn: "USDC" | "EURC" = "USDC",
  tokenOut: "USDC" | "EURC" = "EURC",
): ExternalPayrollXylonetBinding {
  return {
    referenceId: "payroll-1",
    walletAddress: wallet,
    chainId: 5_042_002,
    tokenIn,
    tokenOut,
    tokenInAddress: tokenIn === "USDC" ? usdc : eurc,
    tokenOutAddress: tokenOut === "USDC" ? usdc : eurc,
    amountIn: "1000000",
    minimumRequiredOutput: "970000",
    recipients: [
      {
        id: "recipient-1",
        address: "0x2222222222222222222222222222222222222222",
        targetToken: tokenOut,
        sourceAmount: "1000000",
      },
    ],
  };
}

function quote(
  tokenIn: "USDC" | "EURC" = "USDC",
  tokenOut: "USDC" | "EURC" = "EURC",
): UserSwapQuoteResponse {
  return {
    tokenIn,
    tokenOut,
    tokenInAddress: tokenIn === "USDC" ? usdc : eurc,
    tokenOutAddress: tokenOut === "USDC" ? usdc : eurc,
    amountIn: "1000000",
    fromAddress: wallet,
    toAddress: wallet,
    recipientAddress: wallet,
    chain: "ARC-TESTNET",
    chainId: 5_042_002,
    provider: "xylonet",
    executorAddress: executor,
    routerAddress: router,
    expectedOutput: "990000",
    minimumAmountOut: "970000",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    raw: {},
  };
}

function swapReceipt(amountOut = 980000n) {
  return {
    status: "success" as const,
    logs: [
      {
        address: executor,
        topics: encodeEventTopics({
          abi: WIZPAY_SWAP_EXECUTOR_V2_ABI,
          eventName: "WizPaySwapExecuted",
          args: { user: wallet, router, tokenIn: usdc },
        }) as unknown as readonly Hex[],
        data: encodeAbiParameters(
          parseAbiParameters(
            "address tokenOut, uint256 amountIn, uint256 feeAmount, uint256 netAmountIn, uint256 amountOut, address recipient",
          ),
          [eurc, 1_000_000n, 2_500n, 997_500n, amountOut, wallet],
        ),
      },
    ],
  };
}

function payrollReceipt(referenceId: string) {
  return {
    status: "success" as const,
    logs: [
      {
        address: WIZPAY_ADDRESS,
        topics: encodeEventTopics({
          abi: [WIZPAY_BATCH_PAYMENT_ROUTED_EVENT],
          eventName: "BatchPaymentRouted",
          args: { sender: wallet },
        }) as unknown as readonly Hex[],
        data: encodeAbiParameters(
          parseAbiParameters(
            "address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256 recipientCount, string referenceId",
          ),
          [eurc, eurc, 980000n, 977550n, 2450n, 1n, referenceId],
        ),
      },
    ],
  };
}

function createActions(overrides: Partial<ExternalPayrollXylonetActions> = {}) {
  let allowance = 0n;
  const actions: ExternalPayrollXylonetActions = {
    assertWallet: vi.fn(),
    readAllowance: vi.fn(async () => allowance),
    submitApproval: vi.fn(async () => {
      allowance = 1_000_000n;
      return approvalHash;
    }),
    submitSwap: vi.fn(async () => swapHash),
    waitForReceipt: vi.fn(async (hash) =>
      hash === approvalHash
        ? { status: "success", logs: [] }
        : swapReceipt(),
    ),
    ...overrides,
  };
  return actions;
}

describe("External Wallet payroll XyloNet lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS", executor);
  });

  it.each([
    ["USDC", "EURC"],
    ["EURC", "USDC"],
  ] as const)("executes browser-signed %s to %s and verifies output", async (tokenIn, tokenOut) => {
    const route = binding(tokenIn, tokenOut);
    const actions = createActions({
      waitForReceipt: vi.fn(async (hash) => {
        if (hash === approvalHash) return { status: "success", logs: [] };
        const receipt = swapReceipt();
        if (tokenIn === "EURC") {
          receipt.logs[0] = {
            ...receipt.logs[0],
            topics: encodeEventTopics({
              abi: WIZPAY_SWAP_EXECUTOR_V2_ABI,
              eventName: "WizPaySwapExecuted",
              args: { user: wallet, router, tokenIn: eurc },
            }) as unknown as readonly Hex[],
            data: encodeAbiParameters(
              parseAbiParameters(
                "address tokenOut, uint256 amountIn, uint256 feeAmount, uint256 netAmountIn, uint256 amountOut, address recipient",
              ),
              [usdc, 1_000_000n, 2_500n, 997_500n, 980_000n, wallet],
            ),
          };
        }
        return receipt;
      }),
    });

    const result = await runExternalPayrollXylonetSwap({
      binding: route,
      storage: localStorage,
      quote: async () => quote(tokenIn, tokenOut),
      actions,
    });

    expect(result).toEqual({
      txHash: swapHash,
      verifiedActualOutput: "980000",
      resumed: false,
    });
    expect(actions.submitApproval).toHaveBeenCalledTimes(1);
    expect(actions.submitSwap).toHaveBeenCalledTimes(1);
    expect(actions.assertWallet).toHaveBeenCalledTimes(4);
  });

  it("fails on an expired or worsened-slippage quote before approval", async () => {
    const actions = createActions();
    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(),
        storage: localStorage,
        quote: async () => ({
          ...quote(),
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
        actions,
      }),
    ).rejects.toThrow(/expired/);
    expect(actions.submitApproval).not.toHaveBeenCalled();

    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(),
        storage: localStorage,
        quote: async () => ({ ...quote(), minimumAmountOut: "960000" }),
        actions,
      }),
    ).rejects.toThrow(/below the payroll minimum/);
    expect(actions.submitSwap).not.toHaveBeenCalled();
  });

  it("rejects the wrong connected wallet or chain before writes", async () => {
    const actions = createActions({
      assertWallet: vi.fn(() => {
        throw new Error("connected wallet or chain mismatch");
      }),
    });
    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(),
        storage: localStorage,
        quote: async () => quote(),
        actions,
      }),
    ).rejects.toThrow(/mismatch/);
    expect(actions.submitApproval).not.toHaveBeenCalled();
    expect(actions.submitSwap).not.toHaveBeenCalled();
  });

  it("stops before swap when approval is rejected", async () => {
    const actions = createActions({
      submitApproval: vi.fn(async () => {
        throw new Error("User rejected approval");
      }),
    });
    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(), storage: localStorage, quote: async () => quote(), actions,
      }),
    ).rejects.toThrow(/rejected/);
    expect(actions.submitSwap).not.toHaveBeenCalled();
  });

  it("stops before payroll when the swap receipt fails", async () => {
    const actions = createActions({
      waitForReceipt: vi.fn(async (hash) =>
        hash === approvalHash
          ? { status: "success", logs: [] }
          : { status: "reverted", logs: [] },
      ),
    });
    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(), storage: localStorage, quote: async () => quote(), actions,
      }),
    ).rejects.toThrow(/reverted/);
  });

  it("resumes a confirmed swap after payroll failure without swapping twice", async () => {
    const actions = createActions();
    const input = {
      binding: binding(), storage: localStorage, quote: vi.fn(async () => quote()), actions,
    };
    await runExternalPayrollXylonetSwap(input);
    const resumed = await runExternalPayrollXylonetSwap(input);

    expect(resumed.resumed).toBe(true);
    expect(actions.submitSwap).toHaveBeenCalledTimes(1);
    expect(input.quote).toHaveBeenCalledTimes(1);
  });

  it("fails closed when swap broadcast persistence has an unknown outcome", async () => {
    const actions = createActions();
    let writes = 0;
    const interruptedStorage: Storage = {
      get length() { return localStorage.length; },
      clear: () => localStorage.clear(),
      getItem: (key) => localStorage.getItem(key),
      key: (index) => localStorage.key(index),
      removeItem: (key) => localStorage.removeItem(key),
      setItem: (key, value) => {
        writes += 1;
        if (writes === 2) throw new Error("storage interrupted after broadcast");
        localStorage.setItem(key, value);
      },
    };
    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(),
        storage: interruptedStorage,
        quote: async () => quote(),
        actions,
      }),
    ).rejects.toThrow(/storage interrupted/);
    await expect(
      runExternalPayrollXylonetSwap({
        binding: binding(),
        storage: localStorage,
        quote: async () => quote(),
        actions,
      }),
    ).rejects.toThrow(/unknown outcome/);
    expect(actions.submitSwap).toHaveBeenCalledTimes(1);
  });

  it("resumes against the original persisted minimum after the preview refreshes", async () => {
    const actions = createActions();
    const original = binding();
    await runExternalPayrollXylonetSwap({
      binding: original, storage: localStorage, quote: async () => quote(), actions,
    });
    const refreshedPreview = {
      ...original,
      minimumRequiredOutput: "975000",
    };

    await expect(
      runExternalPayrollXylonetSwap({
        binding: refreshedPreview,
        storage: localStorage,
        quote: async () => {
          throw new Error("a resumed swap must not request another quote");
        },
        actions,
      }),
    ).resolves.toMatchObject({ resumed: true, verifiedActualOutput: "980000" });
    expect(actions.submitSwap).toHaveBeenCalledTimes(1);
  });

  it("binds recovery to recipients and refuses a changed batch", async () => {
    const actions = createActions();
    await runExternalPayrollXylonetSwap({
      binding: binding(), storage: localStorage, quote: async () => quote(), actions,
    });
    const changed = {
      ...binding(),
      recipients: [{ ...binding().recipients[0], sourceAmount: "999999" }],
    };
    await expect(
      runExternalPayrollXylonetSwap({
        binding: changed, storage: localStorage, quote: async () => quote(), actions,
      }),
    ).rejects.toThrow(/does not match/);
    expect(actions.submitSwap).toHaveBeenCalledTimes(1);
  });

  it("recovers only a receipt-verified final payroll batch", async () => {
    const route = binding();
    const actions = createActions();
    await runExternalPayrollXylonetSwap({
      binding: route, storage: localStorage, quote: async () => quote(), actions,
    });
    await recordExternalPayrollBatchConfirmation({
      binding: route,
      storage: localStorage,
      referenceId: "payroll-1",
      txHash: payrollHash,
      waitForReceipt: async () => payrollReceipt("payroll-1"),
    });

    await expect(
      getRecoveredExternalPayrollBatch({
        binding: route,
        storage: localStorage,
        referenceId: "payroll-1",
        waitForReceipt: async () => payrollReceipt("payroll-1"),
      }),
    ).resolves.toBe(payrollHash);
    await expect(
      getRecoveredExternalPayrollBatch({
        binding: route,
        storage: localStorage,
        referenceId: "payroll-1",
        waitForReceipt: async () => payrollReceipt("different-reference"),
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("does not repeat a payroll batch with an unresolved submission outcome", async () => {
    const route = binding();
    const actions = createActions();
    await runExternalPayrollXylonetSwap({
      binding: route, storage: localStorage, quote: async () => quote(), actions,
    });
    beginExternalPayrollBatchSubmission({
      binding: route,
      storage: localStorage,
      referenceId: "payroll-1",
    });

    await expect(
      getRecoveredExternalPayrollBatch({
        binding: route,
        storage: localStorage,
        referenceId: "payroll-1",
        waitForReceipt: async () => payrollReceipt("payroll-1"),
      }),
    ).rejects.toThrow(/unknown outcome/);
  });
});
