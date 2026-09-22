import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUnits } from "viem";

import { SwapScreen } from "./SwapScreen";
import { confirmMainnetSwap, prepareMainnetSwap, quoteUserSwap } from "@/lib/user-swap-service";
import { activeArcChain } from "@/lib/wagmi";
import {
  calculateArcMaxAmount,
  sumGasReserves,
} from "@/lib/arc-gas-reserve";

vi.mock("@/components/providers/CapabilityProvider", () => ({
  useCapability: () => ({
    enabled: true,
    unavailableMessage: null,
    assertEnabled: vi.fn(),
  }),
}));

const state = vi.hoisted(() => ({
  walletAddress: "0x90ab859240b941eaf0cbcbf42df5086e0ad54147" as `0x${string}`,
  hash: `0x${"ab".repeat(32)}` as `0x${string}`,
  approvals: [] as Array<{ to: `0x${string}` }>,
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/useActiveWalletAddress", () => ({
  useActiveWalletAddress: () => ({
    walletAddress: state.walletAddress,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: state.toast }),
}));
vi.mock("@/components/providers/WalletAuthProvider", () => ({
  useWalletAuth: () => ({
    authenticate: vi.fn(async () => "opaque-wallet-session"),
    error: null,
    sessionToken: "opaque-wallet-session",
    state: "authenticated",
  }),
}));
vi.mock("@/hooks/useTokenBalances", () => ({
  useTokenBalances: () => ({
    balances: { USDC: 10_000_000n, EURC: 10_000_000n },
    isLoading: false,
  }),
}));
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useAccount: () => ({ address: state.walletAddress }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWalletClient: () => ({
    data: {
      account: { address: state.walletAddress },
      chain: { id: 5_042 },
      sendTransaction: state.sendTransaction,
    },
  }),
  usePublicClient: () => ({
    getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
    estimateContractGas: vi.fn().mockResolvedValue(50_000n),
    waitForTransactionReceipt: state.waitForTransactionReceipt,
  }),
  useReadContract: () => ({ data: 10_000_000n }),
}));
vi.mock("@/lib/user-swap-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/user-swap-service")>()),
  quoteUserSwap: vi.fn(),
  confirmMainnetSwap: vi.fn(async () => ({ id: "swap-1" })),
  prepareMainnetSwap: vi.fn(async (params: { tokenInAddress: string }) => ({
    walletControl: "external-wallet",
    chainId: 5042,
    poolKey: {},
    poolId: "0xpool",
    quote: {
      zeroForOne: true,
      tokenIn: params.tokenInAddress,
      tokenOut: "0xtokenOut",
      amountIn: "1000000",
      amountOut: "990000",
      gasEstimate: "37000",
      minAmountOut: "990000",
      minHopPriceX36: "1",
      slippageBps: 200,
      poolId: "0xpool",
    },
    approvals:
      params.tokenInAddress.toLowerCase() === eurc.toLowerCase()
        ? [
            {
              to: eurc,
              data: "0xapprove",
              value: "0",
              description: "Approve executor",
            },
          ]
        : [],
    swap: {
      to: "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
      data: "0xswap",
      value: "1000000000000000000",
      description: "Execute swap",
    },
    permit2: null,
    recipient: state.walletAddress,
    deadline: Math.floor(Date.now() / 1_000) + 600,
    executable: false,
  })),
}));
vi.mock("@/lib/mainnet-uniswap-v4", () => ({
  ARC_MAINNET_UNISWAP_V4_UNAVAILABLE_MESSAGE: "unavailable",
  useMainnetUniswapV4Gate: () => ({
    available: true,
    executable: true,
    poolIdentityStatus: "verified-live",
    message: null,
    blockers: [],
  }),
  getMainnetUniswapV4UnavailableState: () => ({
    available: true,
    executable: true,
    poolIdentityStatus: "verified",
    message: null,
    blockers: [],
  }),
}));
vi.mock("@/lib/mainnet-uniswap-v4-protocol", () => ({
  WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS:
    "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
  applySlippage: (amount: bigint) => amount,
  calculateMinHopPriceX36: () => 1n,
  encodeUserControlledApprovals: () => state.approvals,
  mainnetUniswapV4TransactionValue: () => 0n,
}));

const eurc = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";

function mainnetQuote() {
  return {
    tokenIn: "USDC" as const,
    tokenOut: "EURC" as const,
    amountIn: "1000000",
    fromAddress: state.walletAddress,
    toAddress: state.walletAddress,
    chain: "ARC-MAINNET" as const,
    provider: "mainnet-uniswap-v4" as const,
    executorAddress: "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
    expectedOutput: "990000",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    raw: {
      observation: {
        chainId: 5042,
        quoterAddress: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
        poolId: "0xpool",
        tokenInAddress: "0x3600000000000000000000000000000000000000",
        tokenOutAddress: eurc,
        amountIn: "1000000",
        blockNumber: 1,
        amountOut: "990000",
        gasEstimate: "37000",
      },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      expectedAmountOut: "990000",
      minimumAmountOut: "990000",
    },
  };
}

async function enterAmountAndExecute(buttonName: RegExp) {
  fireEvent.change(screen.getByRole("textbox", { name: "Swap amount" }), {
    target: { value: "1" },
  });
  const button = await screen.findByRole(
    "button",
    { name: buttonName },
    { timeout: 5_000 },
  );
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 5_000 });
  fireEvent.click(button);
}

describe("SwapScreen verified success modal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    state.approvals = [];
    state.sendTransaction.mockResolvedValue(state.hash);
    state.waitForTransactionReceipt.mockResolvedValue({
      status: "success",
      logs: [],
    });
    vi.mocked(quoteUserSwap).mockResolvedValue(mainnetQuote());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the locked Mainnet route and token selectors", async () => {
    render(<SwapScreen />);
    expect(
      screen.getByRole("combobox", { name: "From token" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "To token" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Mainnet Swap Executor")).toBeInTheDocument();
    expect(screen.getByText("WizPaySwapExecutorMainnet")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Swap on Arc Mainnet" }),
    ).toBeInTheDocument();
  });

  it("uses a live gas estimate for Max instead of the full USDC balance", async () => {
    render(<SwapScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    const liveReserve = sumGasReserves([50_000n * 1_000_000_000n]);
    const expected = formatUnits(
      calculateArcMaxAmount({
        inputBalance: 10_000_000n,
        nativeUsdcBalance: 10_000_000n,
        reserveUnits: liveReserve.reserveUnits,
        tokenIsUsdc: true,
      }),
      6,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Swap amount" })).toHaveValue(
        expected,
      ),
    );
  });

  it("opens only after Mainnet receipt verification", async () => {
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap on Arc Mainnet/);
    expect(
      await screen.findByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(quoteUserSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenIn: "USDC",
        tokenOut: "EURC",
        chain: "ARC-MAINNET",
      }),
      expect.anything(),
    );
    expect(screen.getByText("1.00 USDC")).toBeInTheDocument();
    expect(screen.getAllByText("0.99 EURC").length).toBeGreaterThan(0);
    expect(confirmMainnetSwap).toHaveBeenCalledWith(
      state.hash,
      "opaque-wallet-session",
    );
    expect(screen.getByText("External Wallet")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /View on explorer/ }),
    ).toHaveAttribute(
      "href",
      `${activeArcChain.blockExplorers?.default.url}/tx/${state.hash}`,
    );
  });

  it("approves the Mainnet executor before executing a EURC swap", async () => {
    state.approvals = [{ to: eurc as `0x${string}` }];
    render(<SwapScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Reverse tokens" }));
    await enterAmountAndExecute(/Swap on Arc Mainnet/);
    expect(
      await screen.findByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(state.sendTransaction).toHaveBeenCalledTimes(2);
    expect(state.sendTransaction.mock.calls[0]?.[0]).toMatchObject({
      to: eurc,
    });
    expect(state.sendTransaction.mock.calls[1]?.[0]).toMatchObject({
      to: "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
    });
  });

  it("shows non-modal progress immediately and keeps one External Wallet submission active", async () => {
    let resolveHash!: (hash: `0x${string}`) => void;
    state.sendTransaction.mockReturnValueOnce(
      new Promise<`0x${string}`>((resolve) => {
        resolveHash = resolve;
      }),
    );
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap on Arc Mainnet/);

    expect(
      screen.getByRole("region", { name: "Swap progress" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Swap amount" })).toBeDisabled();
    expect(screen.queryByText("Approving token")).not.toBeInTheDocument();

    await act(async () => resolveHash(state.hash));
    expect(
      await screen.findByRole("heading", { name: "Swap completed" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Swap progress" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a failed swap visible without retrying automatically", async () => {
    state.sendTransaction.mockRejectedValueOnce(
      new Error("User rejected request"),
    );
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap on Arc Mainnet/);

    expect(await screen.findByText("Swap stopped")).toBeInTheDocument();
    expect(screen.getAllByText(/rejected/i).length).toBeGreaterThan(0);
    expect(state.sendTransaction).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("heading", { name: "Swap completed" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review swap" }));
    expect(
      screen.queryByRole("region", { name: "Swap progress" }),
    ).not.toBeInTheDocument();
    expect(state.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("Start another swap resets only the swap presentation and amount", async () => {
    render(<SwapScreen />);
    await enterAmountAndExecute(/Swap on Arc Mainnet/);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start another swap" }),
    );
    expect(
      screen.queryByRole("heading", { name: "Swap completed" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Swap amount" })).toHaveValue(
      "",
    );
  });
});
