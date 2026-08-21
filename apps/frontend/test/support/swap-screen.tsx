import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactElement,
  ReactNode,
} from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";

import type {
  AppWalletSwapOperationResponse,
  AppWalletSwapProvider,
  AppWalletSwapQuoteResponse,
  AppWalletXylonetOperationResponse,
} from "@/lib/app-wallet-swap-service";

const swapScreenMocks = vi.hoisted(() => ({
  appWallet: {
    attachDepositTxHash: vi.fn(),
    confirmDeposit: vi.fn(),
    createOperation: vi.fn(),
    executeOperation: vi.fn(),
    getOperation: vi.fn(),
    quote: vi.fn(),
    refundOperation: vi.fn(),
    resolveDepositTxHash: vi.fn(),
    submitDeposit: vi.fn(),
    xylonetApprovalChallenge: vi.fn(),
    xylonetApprovalResult: vi.fn(),
    xylonetCreateOperation: vi.fn(),
    xylonetGetOperation: vi.fn(),
    xylonetPoll: vi.fn(),
    xylonetQuote: vi.fn(),
    xylonetSwapChallenge: vi.fn(),
  },
  circle: {
    createTransferChallenge: vi.fn(),
    ensureSessionReady: vi.fn(),
    executeChallenge: vi.fn(),
    getWalletBalances: vi.fn(),
    userToken: "circle-user-token" as string | null,
  },
  circleSwapKit: {
    createAdapter: vi.fn(),
    executePrepared: vi.fn(),
  },
  external: {
    createFundingPresign: vi.fn(),
    createTradableQuote: vi.fn(),
    createTrade: vi.fn(),
    fundTrade: vi.fn(),
    getTrade: vi.fn(),
    prepare: vi.fn(),
    quote: vi.fn(),
  },
  publicClient: {
    getBlockNumber: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  toast: vi.fn(),
  transactionExecutor: {
    signTypedData: vi.fn(),
    signTypedDataWithMetadata: vi.fn(),
  },
  wallet: {
    address: "0x1111111111111111111111111111111111111111" as
      | `0x${string}`
      | undefined,
    mode: "circle" as "circle" | "external" | null,
  },
  walletClient: {
    chain: { id: 5042002 },
    writeContract: vi.fn(),
  },
}));

vi.mock("@/hooks/useActiveWalletAddress", () => ({
  useActiveWalletAddress: () => ({
    isConnected: Boolean(swapScreenMocks.wallet.address),
    walletAddress: swapScreenMocks.wallet.address,
    walletMode: swapScreenMocks.wallet.mode,
  }),
}));

vi.mock("@/components/providers/CircleWalletProvider", () => ({
  useCircleWallet: () => ({
    arcWallet: {
      address: "0x1111111111111111111111111111111111111111",
      blockchain: "ARC-TESTNET",
      id: "circle-wallet-1",
    },
    createTransferChallenge: swapScreenMocks.circle.createTransferChallenge,
    ensureSessionReady: swapScreenMocks.circle.ensureSessionReady,
    executeChallenge: swapScreenMocks.circle.executeChallenge,
    getWalletBalances: swapScreenMocks.circle.getWalletBalances,
    userToken: swapScreenMocks.circle.userToken,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: swapScreenMocks.toast }),
}));

vi.mock("@/hooks/useTransactionExecutor", () => ({
  useTransactionExecutor: () => swapScreenMocks.transactionExecutor,
}));

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");

  function Select({
    children,
    disabled,
    onValueChange,
    value,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    value?: string;
  }) {
    return (
      <select
        disabled={disabled}
        onChange={(event) => onValueChange?.(event.target.value)}
        value={value ?? ""}
      >
        {children}
      </select>
    );
  }

  function SelectTrigger({
    children,
  }: ButtonHTMLAttributes<HTMLButtonElement>) {
    return <>{children}</>;
  }

  function SelectValue({ placeholder }: { placeholder?: string }) {
    return placeholder ? <option value="">{placeholder}</option> : null;
  }

  function SelectContent({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  }

  function SelectItem({
    children,
    value,
  }: {
    children?: ReactNode;
    value: string;
  }) {
    return <option value={value}>{children}</option>;
  }

  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const OpenContext = React.createContext(false);

  function Dialog({
    children,
    open = false,
  }: {
    children?: ReactNode;
    open?: boolean;
  }) {
    return <OpenContext.Provider value={open}>{children}</OpenContext.Provider>;
  }

  function DialogContent({
    children,
    ...props
  }: HTMLAttributes<HTMLDivElement>) {
    return React.useContext(OpenContext) ? (
      <div role="dialog" {...props}>
        {children}
      </div>
    ) : null;
  }

  function DialogHeader({
    children,
    ...props
  }: HTMLAttributes<HTMLDivElement>) {
    return <div {...props}>{children}</div>;
  }

  function DialogTitle({
    children,
    ...props
  }: HTMLAttributes<HTMLHeadingElement>) {
    return <h2 {...props}>{children}</h2>;
  }

  function DialogDescription({
    children,
    ...props
  }: HTMLAttributes<HTMLParagraphElement>) {
    return <p {...props}>{children}</p>;
  }

  return {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  };
});

vi.mock("lucide-react", () => {
  const Icon = () => <svg aria-hidden="true" />;

  return {
    ArrowRightLeft: Icon,
    CheckCircle2: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Clock3: Icon,
    Copy: Icon,
    ExternalLink: Icon,
    Loader2: Icon,
    MessageCircle: Icon,
    ShieldCheck: Icon,
  };
});

vi.mock("wagmi", () => ({
  usePublicClient: () => swapScreenMocks.publicClient,
  useReadContract: () => ({ data: 1_000_000_000n }),
  useWalletClient: () => ({
    data:
      swapScreenMocks.wallet.mode === "external"
        ? swapScreenMocks.walletClient
        : undefined,
  }),
}));

vi.mock("@/lib/wagmi", () => ({
  arcTestnet: {
    id: 5042002,
    name: "Arc Testnet",
  },
}));

vi.mock("@/lib/circle-swap-kit", () => ({
  createArcSwapAdapter: swapScreenMocks.circleSwapKit.createAdapter,
  executePreparedArcUserSwap: swapScreenMocks.circleSwapKit.executePrepared,
}));

vi.mock("@/lib/app-wallet-swap-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/app-wallet-swap-service")>();

  return {
    ...original,
    attachAppWalletSwapDepositTxHash:
      swapScreenMocks.appWallet.attachDepositTxHash,
    confirmAppWalletSwapDeposit: swapScreenMocks.appWallet.confirmDeposit,
    createAppWalletSwapOperation: swapScreenMocks.appWallet.createOperation,
    executeAppWalletSwapOperation: swapScreenMocks.appWallet.executeOperation,
    getAppWalletSwapOperation: swapScreenMocks.appWallet.getOperation,
    quoteAppWalletSwap: swapScreenMocks.appWallet.quote,
    refundAppWalletSwapOperation: swapScreenMocks.appWallet.refundOperation,
    resolveAppWalletSwapDepositTxHash:
      swapScreenMocks.appWallet.resolveDepositTxHash,
    submitAppWalletSwapDeposit: swapScreenMocks.appWallet.submitDeposit,
    quoteAppWalletXylonetSwap: swapScreenMocks.appWallet.xylonetQuote,
    createAppWalletXylonetOperation:
      swapScreenMocks.appWallet.xylonetCreateOperation,
    getAppWalletXylonetOperation: swapScreenMocks.appWallet.xylonetGetOperation,
    createAppWalletXylonetApprovalChallenge:
      swapScreenMocks.appWallet.xylonetApprovalChallenge,
    createAppWalletXylonetSwapChallenge:
      swapScreenMocks.appWallet.xylonetSwapChallenge,
    pollAppWalletXylonetOperation: swapScreenMocks.appWallet.xylonetPoll,
    recordAppWalletXylonetChallengeResult:
      swapScreenMocks.appWallet.xylonetApprovalResult,
  };
});

vi.mock("@/lib/user-swap-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/user-swap-service")>();

  return {
    ...original,
    createStablefxFundingPresign: swapScreenMocks.external.createFundingPresign,
    createStablefxTradableQuote: swapScreenMocks.external.createTradableQuote,
    createStablefxTrade: swapScreenMocks.external.createTrade,
    fundStablefxTrade: swapScreenMocks.external.fundTrade,
    getStablefxTrade: swapScreenMocks.external.getTrade,
    prepareUserSwap: swapScreenMocks.external.prepare,
    quoteUserSwap: swapScreenMocks.external.quote,
  };
});

import { SwapScreen } from "@/components/dashboard/SwapScreen";

const BASE_TIME = "2026-07-26T00:00:00.000Z";

export function createAppWalletQuote(
  provider: AppWalletSwapProvider = "stablefx",
  overrides: Partial<AppWalletSwapQuoteResponse> = {},
): AppWalletSwapQuoteResponse {
  return {
    amountIn: "1000000",
    expectedOutput: "990000",
    expiresAt: "2099-01-01T00:05:00.000Z",
    minimumOutput: "970000",
    operationMode: "treasury-mediated",
    provider,
    quoteId: `${provider}-quote`,
    sourceChain: "ARC-TESTNET",
    status: "quoted",
    tokenIn: "USDC",
    tokenOut: "EURC",
    treasuryDepositAddress: "0x2222222222222222222222222222222222222222",
    ...overrides,
  };
}

export function createAppWalletOperation(
  status: AppWalletSwapOperationResponse["status"] = "awaiting_user_deposit",
  overrides: Partial<AppWalletSwapOperationResponse> = {},
): AppWalletSwapOperationResponse {
  return {
    ...createAppWalletQuote("stablefx"),
    createdAt: BASE_TIME,
    executionEnabled: true,
    operationId: "11111111-1111-4111-8111-111111111111",
    provider: "stablefx",
    status,
    updatedAt: BASE_TIME,
    userWalletAddress: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

export function createXylonetOperation(
  lifecycleStage: AppWalletXylonetOperationResponse["lifecycleStage"] = "created",
  overrides: Partial<AppWalletXylonetOperationResponse> = {},
): AppWalletXylonetOperationResponse {
  return {
    amountIn: "1000000",
    applicationUserId: "circle:user:test",
    chain: "ARC-TESTNET",
    chainId: 5042002,
    circleWalletId: "circle-wallet-1",
    createdAt: BASE_TIME,
    deadline: "1999999999",
    executionMode: "direct-user-controlled",
    executorAddress: "0x3333333333333333333333333333333333333333",
    expectedOutput: "990000",
    feeBps: 25,
    lifecycleStage,
    minimumOutput: "970000",
    operationId: "22222222-2222-4222-8222-222222222222",
    provider: "xylonet",
    recipientAddress: "0x1111111111111111111111111111111111111111",
    routerAddress: "0x4444444444444444444444444444444444444444",
    slippageBps: 200,
    tokenIn: "USDC",
    tokenInAddress: "0x3600000000000000000000000000000000000000",
    tokenOut: "EURC",
    tokenOutAddress: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    updatedAt: BASE_TIME,
    walletAddress: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

export function resetSwapScreenMocks() {
  for (const group of [
    swapScreenMocks.appWallet,
    swapScreenMocks.circle,
    swapScreenMocks.circleSwapKit,
    swapScreenMocks.external,
    swapScreenMocks.publicClient,
    swapScreenMocks.transactionExecutor,
    swapScreenMocks.walletClient,
  ]) {
    for (const value of Object.values(group)) {
      if (vi.isMockFunction(value)) {
        value.mockReset();
      }
    }
  }
  swapScreenMocks.toast.mockReset();

  swapScreenMocks.wallet.address = "0x1111111111111111111111111111111111111111";
  swapScreenMocks.wallet.mode = "circle";
  swapScreenMocks.walletClient.chain = { id: 5042002 };
  swapScreenMocks.circle.userToken = "circle-user-token";

  swapScreenMocks.appWallet.quote.mockResolvedValue(
    createAppWalletQuote("stablefx", { amountIn: "10000000" }),
  );
  swapScreenMocks.appWallet.xylonetQuote.mockResolvedValue(
    createAppWalletQuote("xylonet", {
      operationMode: "direct-user-controlled",
      treasuryDepositAddress: undefined,
    }),
  );
  swapScreenMocks.appWallet.xylonetCreateOperation.mockResolvedValue(
    createXylonetOperation(),
  );
  swapScreenMocks.appWallet.xylonetApprovalChallenge.mockResolvedValue(
    createXylonetOperation("awaiting_approval_confirmation", {
      approvalChallengeId: "approval-challenge-1",
    }),
  );
  swapScreenMocks.appWallet.xylonetApprovalResult.mockImplementation(
    async (
      _id: string,
      stage: "approval" | "swap",
      result: { status: string },
    ) =>
      result.status === "COMPLETE"
        ? createXylonetOperation(
            stage === "approval" ? "approval_submitted" : "swap_submitted",
          )
        : createXylonetOperation(
            result.status.toLowerCase() as AppWalletXylonetOperationResponse["lifecycleStage"],
            {
              terminalStatus: result.status.toLowerCase() as NonNullable<
                AppWalletXylonetOperationResponse["terminalStatus"]
              >,
            },
          ),
  );
  swapScreenMocks.appWallet.xylonetSwapChallenge.mockResolvedValue(
    createXylonetOperation("awaiting_swap_confirmation", {
      swapChallengeId: "swap-challenge-1",
    }),
  );
  swapScreenMocks.appWallet.xylonetPoll.mockResolvedValue(
    createXylonetOperation("completed", {
      terminalStatus: "confirmed",
      completedAt: BASE_TIME,
    }),
  );
  swapScreenMocks.appWallet.xylonetGetOperation.mockResolvedValue(
    createXylonetOperation("completed", { terminalStatus: "confirmed" }),
  );
  swapScreenMocks.appWallet.createOperation.mockResolvedValue(
    createAppWalletOperation(),
  );
  swapScreenMocks.appWallet.submitDeposit.mockResolvedValue(
    createAppWalletOperation("deposit_submitted"),
  );
  swapScreenMocks.appWallet.attachDepositTxHash.mockImplementation(
    async (_operationId, request: { depositTxHash: string }) =>
      createAppWalletOperation("deposit_submitted", {
        depositTxHash: request.depositTxHash,
      }),
  );
  swapScreenMocks.appWallet.resolveDepositTxHash.mockResolvedValue(
    createAppWalletOperation("deposit_submitted"),
  );
  swapScreenMocks.appWallet.confirmDeposit.mockResolvedValue(
    createAppWalletOperation("deposit_confirmed", {
      depositConfirmedAmount: "1000000",
      depositConfirmedAt: BASE_TIME,
      depositTxHash: `0x${"a".repeat(64)}`,
    }),
  );
  swapScreenMocks.appWallet.executeOperation.mockResolvedValue(
    createAppWalletOperation("completed", {
      completedAt: BASE_TIME,
      payoutAmount: "990000",
      payoutConfirmedAt: BASE_TIME,
    }),
  );
  swapScreenMocks.appWallet.getOperation.mockImplementation(async () =>
    createAppWalletOperation("refund_submitted", {
      refundAmount: "1000000",
      refundSubmittedAt: BASE_TIME,
      refundTransactionId: "refund-transaction-1",
    }),
  );
  swapScreenMocks.appWallet.refundOperation.mockResolvedValue(
    createAppWalletOperation("refund_submitted", {
      refundAmount: "1000000",
      refundSubmittedAt: BASE_TIME,
      refundTransactionId: "refund-transaction-1",
    }),
  );

  swapScreenMocks.circle.ensureSessionReady.mockResolvedValue(undefined);
  swapScreenMocks.circle.getWalletBalances.mockResolvedValue([
    {
      amount: "10",
      symbol: "USDC",
      tokenAddress: "0x3600000000000000000000000000000000000000",
      tokenId: "usdc-token-id",
    },
  ]);
  swapScreenMocks.circle.createTransferChallenge.mockResolvedValue({
    challengeId: "deposit-challenge-1",
    raw: {},
  });
  swapScreenMocks.circle.executeChallenge.mockResolvedValue({
    status: "COMPLETE",
  });

  swapScreenMocks.circleSwapKit.createAdapter.mockReturnValue({});
  swapScreenMocks.publicClient.getBlockNumber.mockResolvedValue(1n);
  swapScreenMocks.publicClient.readContract.mockResolvedValue(0n);
  swapScreenMocks.publicClient.waitForTransactionReceipt.mockResolvedValue({
    status: "success",
  });
}

export function renderSwapScreen(): ReturnType<typeof render> {
  return render((<SwapScreen />) as ReactElement);
}

export { SwapScreen, swapScreenMocks };
