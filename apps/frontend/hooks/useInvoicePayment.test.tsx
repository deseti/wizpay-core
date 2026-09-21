import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackendApiError } from "@/lib/backend-api";
import { useInvoicePayment } from "@/hooks/useInvoicePayment";
import {
  verifyPublicInvoicePayment,
  type PublicInvoice,
} from "@/lib/invoice-api";

const writeContractAsync = vi.fn();
const switchChainAsync = vi.fn();
const {
  acquireExecutionIntent,
  bindExecutionIntentTransactionHash,
  bindKnownExecutionIntentHash,
  cancelExecutionIntent,
  prepareWalletExecutionIntent,
} = vi.hoisted(() => ({
  acquireExecutionIntent: vi.fn(),
  bindExecutionIntentTransactionHash: vi.fn(),
  bindKnownExecutionIntentHash: vi.fn(),
  cancelExecutionIntent: vi.fn(),
  prepareWalletExecutionIntent: vi.fn(),
}));
let account = {
  address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  chainId: 1,
  isConnected: true,
};

vi.mock("wagmi", () => ({
  useAccount: () => account,
  useSwitchChain: () => ({ switchChainAsync }),
  useWriteContract: () => ({ writeContractAsync }),
}));
vi.mock("@/lib/invoice-api", async (original) => ({
  ...(await original<typeof import("@/lib/invoice-api")>()),
  verifyPublicInvoicePayment: vi.fn(),
}));
vi.mock("@/lib/execution-intent", () => ({
  acquireExecutionIntent,
  bindExecutionIntentTransactionHash,
  bindKnownExecutionIntentHash,
  cancelExecutionIntent,
  prepareWalletExecutionIntent,
}));

describe("useInvoicePayment", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    writeContractAsync.mockReset();
    switchChainAsync.mockReset();
    vi.mocked(verifyPublicInvoicePayment).mockReset();
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: () => "idempotency-key",
    });
    acquireExecutionIntent.mockReset().mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      status: "CREATED",
      circleChallengeId: null,
      circleTransactionId: null,
      transactionHash: null,
    });
    bindExecutionIntentTransactionHash.mockReset().mockResolvedValue({});
    bindKnownExecutionIntentHash.mockReset().mockResolvedValue({});
    cancelExecutionIntent.mockReset().mockResolvedValue({});
    prepareWalletExecutionIntent.mockReset().mockResolvedValue({});
    account = {
      address: "0x1111111111111111111111111111111111111111",
      chainId: 1,
      isConnected: true,
    };
    writeContractAsync.mockResolvedValue(`0x${"a".repeat(64)}`);
    vi.mocked(verifyPublicInvoicePayment).mockResolvedValue({
      ...invoice(),
      status: "PAID",
      paymentStatus: "VERIFIED",
      transactionHash: `0x${"a".repeat(64)}`,
    });
  });

  it("switches to Arc Mainnet, requests one exact transfer, locks duplicate submission, and verifies backend authority", async () => {
    const onInvoice = vi.fn();
    const { result } = renderHook(() =>
      useInvoicePayment(invoice(), onInvoice),
    );
    await act(async () => {
      await Promise.all([result.current.pay(), result.current.pay()]);
    });
    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 5_042 });
    expect(acquireExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "arc-mainnet",
        operation: "INVOICE_SETTLEMENT",
      }),
    );
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    expect(writeContractAsync.mock.calls[0][0]).toMatchObject({
      address: invoice().token.address,
      chainId: 5_042,
      functionName: "transfer",
      args: [invoice().receivingAddress, 100000n],
    });
    expect(verifyPublicInvoicePayment).toHaveBeenCalledWith(
      invoice().publicId,
      `0x${"a".repeat(64)}`,
    );
    expect(onInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PAID" }),
    );
  });

  it("restores verification after refresh without requesting another signature", async () => {
    localStorage.setItem(
      `wizpay.invoice-payment.v1.${invoice().publicId}`,
      JSON.stringify({
        version: 2,
        method: "external",
        publicId: invoice().publicId,
        executionIntentId: "11111111-1111-4111-8111-111111111111",
        executionIntentKey: "22222222-2222-4222-8222-222222222222",
        leaseOwner: "browser-1",
        payerAddress: account.address,
        transactionHash: `0x${"b".repeat(64)}`,
        createdAt: new Date().toISOString(),
        stage: "confirming_onchain",
      }),
    );
    const onInvoice = vi.fn();
    renderHook(() =>
      useInvoicePayment(
        { ...invoice(), status: "VERIFYING", paymentStatus: "VERIFYING" },
        onInvoice,
      ),
    );
    await waitFor(() =>
      expect(verifyPublicInvoicePayment).toHaveBeenCalledWith(
        invoice().publicId,
        `0x${"b".repeat(64)}`,
      ),
    );
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it("keeps RPC failures retryable and rejects self-payment before wallet execution", async () => {
    vi.mocked(verifyPublicInvoicePayment).mockRejectedValueOnce(
      new BackendApiError(
        "Arc temporarily unavailable",
        503,
        "INVOICE_RPC_UNAVAILABLE",
      ),
    );
    const firstOnInvoice = vi.fn();
    const first = renderHook(() =>
      useInvoicePayment(invoice(), firstOnInvoice),
    );
    await act(async () => {
      await first.result.current.pay();
    });
    expect(first.result.current.stage).toBe("recoverable_error");
    first.unmount();

    vi.clearAllMocks();
    localStorage.clear();
    account = {
      address: invoice().receivingAddress,
      chainId: 5_042,
      isConnected: true,
    };
    const secondOnInvoice = vi.fn();
    const second = renderHook(() =>
      useInvoicePayment(invoice(), secondOnInvoice),
    );
    await act(async () => {
      await second.result.current.pay();
    });
    expect(second.result.current.stage).toBe("terminal_error");
    expect(second.result.current.error).toContain(
      "merchant's receiving wallet",
    );
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it("locks the submitted hash after a terminal backend verification rejection", async () => {
    vi.mocked(verifyPublicInvoicePayment).mockRejectedValueOnce(
      new BackendApiError(
        "The transfer amount does not exactly match this invoice.",
        422,
        "INVOICE_WRONG_AMOUNT",
      ),
    );
    const { result } = renderHook(() => useInvoicePayment(invoice(), vi.fn()));

    await act(async () => {
      await result.current.pay();
    });

    expect(result.current.stage).toBe("terminal_error");
    expect(result.current.locked).toBe(true);
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.pay();
    });
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });

  it("stops safely on a pre-hash wallet ambiguity and requires explicit recovery", async () => {
    writeContractAsync.mockRejectedValueOnce(
      new Error("Wallet provider disconnected after submission."),
    );
    const { result } = renderHook(() => useInvoicePayment(invoice(), vi.fn()));
    await act(async () => {
      await result.current.pay();
    });
    expect(prepareWalletExecutionIntent).toHaveBeenCalledTimes(1);
    expect(result.current.externalRecoveryNeedsHash).toBe(true);
    expect(result.current.locked).toBe(true);
    const recovery = JSON.parse(
      localStorage.getItem(`wizpay.invoice-payment.v1.${invoice().publicId}`)!,
    );
    expect(recovery).toMatchObject({
      method: "external",
      stage: "awaiting_wallet_signature",
    });
    expect(recovery).not.toHaveProperty("transactionHash");
    await act(async () => {
      await result.current.pay();
    });
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.recoverExternalHash(`0x${"d".repeat(64)}`);
    });
    expect(bindKnownExecutionIntentHash).toHaveBeenCalledTimes(1);
  });

  it("rejects non-external payer selection without submitting", async () => {
    const { result } = renderHook(() => useInvoicePayment(invoice(), vi.fn()));
    act(() => result.current.selectMethod("app"));
    expect(result.current.error).toContain(
      "external wallet payments only",
    );
    expect(result.current.method).toBe("external");
    await act(async () => {
      await result.current.pay();
    });
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps a Payment Link caller distinct from a normal invoice settlement", async () => {
    const { result } = renderHook(() =>
      useInvoicePayment(
        { ...invoice(), settlementOperation: "PAYMENT_LINK_SETTLEMENT" },
        vi.fn(),
      ),
    );
    await act(async () => {
      await result.current.pay();
    });
    expect(acquireExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "PAYMENT_LINK_SETTLEMENT" }),
    );
  });

  it("ignores legacy non-external recovery records without verifying", async () => {
    localStorage.setItem(
      `wizpay.invoice-payment.v1.${invoice().publicId}`,
      JSON.stringify({
        version: 2,
        method: "app",
        publicId: invoice().publicId,
        authMethod: "email",
        walletId: "arc-wallet-1",
        payerAddress: account.address,
        challengeId: "challenge-1",
        transactionHash: `0x${"d".repeat(64)}`,
        createdAt: new Date().toISOString(),
        stage: "confirming_onchain",
      }),
    );
    renderHook(() =>
      useInvoicePayment({ ...invoice(), status: "VERIFYING" }, vi.fn()),
    );

    await waitFor(() =>
      expect(writeContractAsync).not.toHaveBeenCalled(),
    );
    expect(verifyPublicInvoicePayment).not.toHaveBeenCalled();
  });
});

function invoice(): PublicInvoice {
  return {
    publicId: "abcdefghijklmnopqrstuv",
    settlementOperation: "INVOICE_SETTLEMENT",
    merchantDisplayLabel: null,
    receivingAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
    receivingAddressShort: "0x32F2...6F69",
    chain: { id: 5_042, name: "Arc Mainnet" },
    token: {
      symbol: "USDC",
      name: "USD Coin",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    },
    amount: "0.1",
    amountUnits: "100000",
    title: "Test invoice",
    description: "For testing",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "OPEN",
    paymentStatus: null,
    verificationCode: null,
    transactionHash: null,
    paidAt: null,
  };
}
