import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwapScreen } from "./SwapScreen";
import { quoteUserSwap } from "@/lib/user-swap-service";
import {
  createAppWalletXylonetOperation,
  quoteAppWalletXylonetSwap,
} from "@/lib/app-wallet-swap-service";
import {
  validateExternalXylonetQuote,
  verifyExternalXylonetReceipt,
} from "@/lib/external-xylonet-swap";
import { runAppWalletXylonetLifecycle } from "@/lib/app-wallet-xylonet-lifecycle";

const state = vi.hoisted(() => ({
  walletMode: "external" as "external" | "circle",
  walletAddress:
    "0x90ab859240b941eaf0cbcbf42df5086e0ad54147" as `0x${string}`,
  hash: `0x${"ab".repeat(32)}` as `0x${string}`,
  writeContract: vi.fn(),
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useActiveWalletAddress", () => ({
  useActiveWalletAddress: () => ({
    walletAddress: state.walletAddress,
    walletMode: state.walletMode,
  }),
}));
vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({
    arcWallet: { id: "wallet-1" },
    executeChallenge: vi.fn(),
    userToken: "user-token",
  }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: state.toast }),
}));
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useAccount: () => ({ address: state.walletAddress }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWalletClient: () => ({
    data: {
      account: { address: state.walletAddress },
      chain: { id: 5_042_002 },
      writeContract: state.writeContract,
    },
  }),
  usePublicClient: () => ({
    readContract: state.readContract,
    waitForTransactionReceipt: state.waitForTransactionReceipt,
  }),
  useReadContract: () => ({ data: 10_000_000n }),
}));
vi.mock("@/lib/user-swap-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/user-swap-service")>()),
  quoteUserSwap: vi.fn(),
}));
vi.mock("@/lib/app-wallet-swap-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-wallet-swap-service")>()),
  quoteAppWalletXylonetSwap: vi.fn(),
  createAppWalletXylonetOperation: vi.fn(),
}));
vi.mock("@/lib/external-xylonet-swap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/external-xylonet-swap")>()),
  validateExternalXylonetQuote: vi.fn(),
  verifyExternalXylonetReceipt: vi.fn(),
}));
vi.mock("@/lib/app-wallet-xylonet-lifecycle", () => ({
  runAppWalletXylonetLifecycle: vi.fn(),
}));

const executor = "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed";
const router = "0x73742278c31a76dBb0D2587d03ef92E6E2141023";
const usdc = "0x3600000000000000000000000000000000000000";
const eurc = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

function externalQuote() {
  return {
    tokenIn: "USDC" as const,
    tokenOut: "EURC" as const,
    tokenInAddress: usdc,
    tokenOutAddress: eurc,
    amountIn: "1000000",
    fromAddress: state.walletAddress,
    toAddress: state.walletAddress,
    recipientAddress: state.walletAddress,
    chain: "ARC-TESTNET" as const,
    chainId: 5_042_002,
    provider: "xylonet" as const,
    executorAddress: executor,
    routerAddress: router,
    expectedOutput: "990000",
    minimumAmountOut: "900000",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    raw: {},
  };
}

function appQuote() {
  return {
    operationMode: "direct-user-controlled" as const,
    executionMode: "direct-user-controlled" as const,
    sourceChain: "ARC-TESTNET" as const,
    tokenIn: "USDC" as const,
    tokenOut: "EURC" as const,
    amountIn: "1000000",
    expectedOutput: "990000",
    minimumOutput: "900000",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    status: "quoted" as const,
    provider: "xylonet" as const,
    walletAddress: state.walletAddress,
    recipientAddress: state.walletAddress,
    executorAddress: executor,
  };
}

async function enterAmountAndExecute(buttonName: RegExp) {
  fireEvent.change(screen.getByRole("textbox", { name: "Swap amount" }), {
    target: { value: "1" },
  });
  const button = await screen.findByRole("button", { name: buttonName }, { timeout: 2_000 });
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 2_000 });
  fireEvent.click(button);
}

describe("SwapScreen verified success modal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.walletMode = "external";
    state.writeContract.mockResolvedValue(state.hash);
    state.readContract.mockResolvedValue(10_000_000n);
    state.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [],
    });
    vi.mocked(quoteUserSwap).mockResolvedValue(externalQuote());
    vi.mocked(validateExternalXylonetQuote).mockReturnValue({
      executor,
      router,
      tokenIn: usdc,
      tokenOut: eurc,
      amountIn: 1_000_000n,
      minimumAmountOut: 900_000n,
      recipient: state.walletAddress,
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 600),
    });
    vi.mocked(verifyExternalXylonetReceipt).mockReturnValue(950_000n);
    vi.mocked(quoteAppWalletXylonetSwap).mockResolvedValue(appQuote());
    vi.mocked(createAppWalletXylonetOperation).mockResolvedValue({
      ...appQuote(),
      operationId: "operation-1",
      applicationUserId: "user-1",
      circleWalletId: "wallet-1",
      walletAddress: state.walletAddress,
      chain: "ARC-TESTNET",
      chainId: 5_042_002,
      tokenInAddress: usdc,
      tokenOutAddress: eurc,
      slippageBps: 200,
      feeBps: 25,
      routerAddress: router,
      executorAddress: executor,
      recipientAddress: state.walletAddress,
      deadline: String(Math.floor(Date.now() / 1_000) + 600),
      lifecycleStage: "created",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS", executor);
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: () => "idempotency-key",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders canonical PNG artwork in the Swap token selectors", async () => {
    render(<SwapScreen />);
    fireEvent.click(screen.getByRole("combobox", { name: "From token" }));
    await waitFor(() => {
      expect(document.querySelector('img[src$="/tokens/usdc.png"]')).toBeInTheDocument();
      expect(document.querySelector('img[src$="/tokens/eurc.png"]')).toBeInTheDocument();
    });
  });

  it("opens only after External Wallet receipt verification", async () => {
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap with XyloNet/);
    expect(
      await screen.findByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(verifyExternalXylonetReceipt).toHaveBeenCalledOnce();
    expect(screen.getByText("1.00 USDC")).toBeInTheDocument();
    expect(screen.getByText("0.95 EURC")).toBeInTheDocument();
    expect(screen.getByText("External Wallet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on explorer/ })).toHaveAttribute(
      "href",
      `https://testnet.arcscan.app/tx/${state.hash}`,
    );
  });

  it("shows non-modal progress immediately and keeps one External Wallet submission active", async () => {
    let resolveHash!: (hash: `0x${string}`) => void;
    state.writeContract.mockReturnValueOnce(
      new Promise<`0x${string}`>((resolve) => {
        resolveHash = resolve;
      }),
    );
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap with XyloNet/);

    expect(screen.getByRole("region", { name: "Swap progress" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Swap amount" })).toBeDisabled();
    expect(screen.queryByText("Approving token")).not.toBeInTheDocument();

    const submit = await screen.findByRole("button", { name: /signing/i });
    fireEvent.click(submit);
    expect(state.writeContract).toHaveBeenCalledTimes(1);

    await act(async () => resolveHash(state.hash));
    expect(
      await screen.findByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Swap progress" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a failed swap visible without retrying automatically", async () => {
    state.writeContract.mockRejectedValueOnce(new Error("User rejected request"));
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap with XyloNet/);

    expect(await screen.findByText("Swap stopped")).toBeInTheDocument();
    expect(screen.getAllByText(/rejected/i).length).toBeGreaterThan(0);
    expect(state.writeContract).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("heading", { name: "Swap completed" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review swap" }));
    expect(
      screen.queryByRole("region", { name: "Swap progress" }),
    ).not.toBeInTheDocument();
    expect(state.writeContract).toHaveBeenCalledTimes(1);
  });

  it("opens after App Wallet reports confirmed completion and verified output", async () => {
    state.walletMode = "circle";
    vi.mocked(runAppWalletXylonetLifecycle).mockResolvedValue({
      ...(await createAppWalletXylonetOperation(
        {} as never,
        "user-token",
      )),
      lifecycleStage: "completed",
      terminalStatus: "confirmed",
      verifiedActualOutput: "960000",
      swapTransactionHash: state.hash,
    });
    render(<SwapScreen />);
    await enterAmountAndExecute(/Confirm XyloNet swap/);
    expect(
      await screen.findByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("0.96 EURC")).toBeInTheDocument();
    expect(screen.getByText("App Wallet")).toBeInTheDocument();
  });

  it.each([
    ["submitted", { lifecycleStage: "swap_submitted" }],
    ["failed", { lifecycleStage: "failed", terminalStatus: "failed" }],
    [
      "confirmed without verified output",
      {
        lifecycleStage: "completed",
        terminalStatus: "confirmed",
        swapTransactionHash: state.hash,
      },
    ],
  ])("does not open for %s App Wallet state", async (_label, override) => {
    state.walletMode = "circle";
    vi.mocked(runAppWalletXylonetLifecycle).mockResolvedValue({
      ...(await createAppWalletXylonetOperation(
        {} as never,
        "user-token",
      )),
      ...override,
    } as never);
    render(<SwapScreen />);
    await enterAmountAndExecute(/Confirm XyloNet swap/);
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(
      screen.queryByRole("heading", { name: "Swap completed" }),
    ).not.toBeInTheDocument();
  });

  it("Start another swap resets only the swap presentation and amount", async () => {
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap with XyloNet/);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start another swap" }),
    );
    expect(
      screen.queryByRole("heading", { name: "Swap completed" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Swap amount" })).toHaveValue("");
  });
});
