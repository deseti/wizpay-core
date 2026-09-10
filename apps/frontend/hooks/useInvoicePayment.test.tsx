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
const circle = vi.hoisted(() => ({
  authenticated: true,
  authMethod: "email" as "email" | "google" | "passkey" | null,
  userToken: "circle-user-token" as string | null,
  payerAddress: "0x2222222222222222222222222222222222222222",
  login: vi.fn(),
  ensureSessionReady: vi.fn(),
  createContractExecutionChallenge: vi.fn(),
  executeChallenge: vi.fn(),
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
vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({
    authenticated: circle.authenticated,
    authMethod: circle.authMethod,
    userToken: circle.userToken,
    login: circle.login,
    ensureSessionReady: circle.ensureSessionReady,
    createContractExecutionChallenge: circle.createContractExecutionChallenge,
    executeChallenge: circle.executeChallenge,
    arcWallet: {
      id: "arc-wallet-1",
      address: circle.payerAddress,
      blockchain: "ARC-TESTNET",
    },
    sepoliaWallet: { id: "sepolia-wallet-1", address: circle.payerAddress },
    primaryWallet: { id: "arc-wallet-1", address: circle.payerAddress },
  }),
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
    circle.authenticated = true;
    circle.authMethod = "email";
    circle.userToken = "circle-user-token";
    circle.payerAddress = "0x2222222222222222222222222222222222222222";
    circle.login.mockReset();
    circle.ensureSessionReady.mockReset().mockResolvedValue(undefined);
    circle.createContractExecutionChallenge.mockReset().mockResolvedValue({
      challengeId: "challenge-1",
      raw: {},
    });
    circle.executeChallenge.mockReset().mockResolvedValue({
      transactionHash: `0x${"c".repeat(64)}`,
    });
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

  it("switches to Arc, requests one exact transfer, locks duplicate submission, and verifies backend authority", async () => {
    const onInvoice = vi.fn();
    const { result } = renderHook(() =>
      useInvoicePayment(invoice(), onInvoice),
    );
    await act(async () => {
      await Promise.all([result.current.pay(), result.current.pay()]);
    });
    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 5_042_002 });
    expect(acquireExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "INVOICE_SETTLEMENT" }),
    );
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    expect(writeContractAsync.mock.calls[0][0]).toMatchObject({
      address: invoice().token.address,
      chainId: 5_042_002,
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
      chainId: 5_042_002,
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

  it("routes App Wallet selection through one user-controlled contract execution and the shared verifier", async () => {
    const onInvoice = vi.fn();
    vi.mocked(verifyPublicInvoicePayment).mockResolvedValue({
      ...invoice(),
      status: "PAID",
      paymentStatus: "VERIFIED",
      transactionHash: `0x${"c".repeat(64)}`,
    });
    const { result } = renderHook(() =>
      useInvoicePayment(invoice(), onInvoice),
    );

    act(() => result.current.selectMethod("app"));
    await act(async () => {
      await Promise.all([result.current.pay(), result.current.pay()]);
    });

    expect(circle.ensureSessionReady).toHaveBeenCalledTimes(1);
    expect(circle.createContractExecutionChallenge).toHaveBeenCalledTimes(1);
    expect(circle.createContractExecutionChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "arc-wallet-1",
        contractAddress: invoice().token.address,
        callData: `0xa9059cbb${invoice().receivingAddress.slice(2).toLowerCase().padStart(64, "0")}${BigInt(invoice().amountUnits).toString(16).padStart(64, "0")}`,
        feeLevel: "MEDIUM",
        idempotencyKey: expect.any(String),
        refId: expect.stringMatching(/^INV-/),
      }),
    );
    expect(circle.executeChallenge).toHaveBeenCalledTimes(1);
    expect(writeContractAsync).not.toHaveBeenCalled();
    expect(verifyPublicInvoicePayment).toHaveBeenCalledWith(
      invoice().publicId,
      `0x${"c".repeat(64)}`,
    );
    expect(onInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PAID" }),
    );
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

  it("opens App Wallet authentication without creating a challenge when unauthenticated", async () => {
    circle.authenticated = false;
    circle.authMethod = null;
    circle.userToken = null;
    const { result } = renderHook(() => useInvoicePayment(invoice(), vi.fn()));
    act(() => result.current.selectMethod("app"));

    await act(async () => {
      await result.current.pay();
    });

    expect(circle.login).toHaveBeenCalledTimes(1);
    expect(circle.createContractExecutionChallenge).not.toHaveBeenCalled();
    expect(circle.executeChallenge).not.toHaveBeenCalled();
    expect(result.current.stage).toBe("authenticating_app_wallet");
  });

  it("rejects App Wallet self-payment before creating a signature challenge", async () => {
    circle.payerAddress = invoice().receivingAddress;
    const { result } = renderHook(() => useInvoicePayment(invoice(), vi.fn()));
    act(() => result.current.selectMethod("app"));

    await act(async () => {
      await result.current.pay();
    });

    expect(result.current.stage).toBe("terminal_error");
    expect(result.current.error).toContain("merchant's receiving wallet");
    expect(circle.createContractExecutionChallenge).not.toHaveBeenCalled();
  });

  it("restores an App Wallet hash and hands it to verification without another challenge", async () => {
    localStorage.setItem(
      `wizpay.invoice-payment.v1.${invoice().publicId}`,
      JSON.stringify({
        version: 2,
        method: "app",
        publicId: invoice().publicId,
        authMethod: "email",
        walletId: "arc-wallet-1",
        payerAddress: circle.payerAddress,
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
      expect(verifyPublicInvoicePayment).toHaveBeenCalledWith(
        invoice().publicId,
        `0x${"d".repeat(64)}`,
      ),
    );
    expect(circle.createContractExecutionChallenge).not.toHaveBeenCalled();
    expect(circle.executeChallenge).not.toHaveBeenCalled();
  });
});

function invoice(): PublicInvoice {
  return {
    publicId: "abcdefghijklmnopqrstuv",
    settlementOperation: "INVOICE_SETTLEMENT",
    merchantDisplayLabel: null,
    receivingAddress: "0x32F251fc36A1174901124589EAC2d4E391816F69",
    receivingAddressShort: "0x32F2...6F69",
    chain: { id: 5_042_002, name: "Arc Testnet" },
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
