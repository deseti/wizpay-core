import {
  decodeEventLog,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import type { UserSwapQuoteResponse } from "@/lib/user-swap-service";
import { arcTestnet } from "@/lib/wagmi";
import type { TokenSymbol } from "@/lib/wizpay";

export const WIZPAY_SWAP_EXECUTOR_V2_ABI = [
  {
    inputs: [
      { name: "router", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    name: "executeSwap",
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    type: "event",
    name: "WizPaySwapExecuted",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "router", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "netAmountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "recipient", type: "address", indexed: false },
    ],
  },
] as const;

export interface ExpectedExternalXylonetSwap {
  walletAddress: Address;
  chainId: number;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  tokenInAddress: Address;
  tokenOutAddress: Address;
  amountIn: bigint;
  nowMs?: number;
}

export interface ValidatedExternalXylonetQuote {
  executor: Address;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minimumAmountOut: bigint;
  recipient: Address;
  deadline: bigint;
}

function requireAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`XyloNet quote ${label} is invalid.`);
  }
  return getAddress(value);
}

function requirePositiveBaseUnits(value: unknown, label: string): bigint {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    BigInt(value) <= 0n
  ) {
    throw new Error(`XyloNet quote ${label} is invalid.`);
  }
  return BigInt(value);
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

export function validateExternalXylonetQuote(
  quote: UserSwapQuoteResponse,
  expected: ExpectedExternalXylonetSwap,
): ValidatedExternalXylonetQuote {
  if (quote.provider !== "xylonet")
    throw new Error("XyloNet is the only supported swap provider.");
  if (
    quote.chain !== "ARC-TESTNET" ||
    quote.chainId !== arcTestnet.id ||
    expected.chainId !== arcTestnet.id
  ) {
    throw new Error("XyloNet quote chain does not match Arc Testnet.");
  }
  if (
    quote.tokenIn !== expected.tokenIn ||
    quote.tokenOut !== expected.tokenOut
  ) {
    throw new Error(
      "XyloNet quote token pair does not match the current request.",
    );
  }
  if (quote.amountIn !== expected.amountIn.toString()) {
    throw new Error("XyloNet quote amount does not match the current request.");
  }
  if (
    !sameAddress(quote.fromAddress, expected.walletAddress) ||
    !sameAddress(quote.toAddress, expected.walletAddress)
  ) {
    throw new Error(
      "XyloNet quote wallet does not match the connected wallet.",
    );
  }

  const recipient = requireAddress(quote.recipientAddress, "recipient");
  const tokenIn = requireAddress(quote.tokenInAddress, "input token");
  const tokenOut = requireAddress(quote.tokenOutAddress, "output token");
  if (!sameAddress(recipient, expected.walletAddress))
    throw new Error("XyloNet quote recipient mismatch.");
  if (
    !sameAddress(tokenIn, expected.tokenInAddress) ||
    !sameAddress(tokenOut, expected.tokenOutAddress)
  ) {
    throw new Error("XyloNet quote token address mismatch.");
  }

  const configuredExecutor =
    process.env.NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS;
  const executor = requireAddress(quote.executorAddress, "executor");
  if (
    !configuredExecutor ||
    !isAddress(configuredExecutor) ||
    !sameAddress(executor, configuredExecutor)
  ) {
    throw new Error(
      "XyloNet quote executor does not match canonical WizPaySwapExecutorV2.",
    );
  }
  const router = requireAddress(quote.routerAddress, "router");
  const minimumAmountOut = requirePositiveBaseUnits(
    quote.minimumAmountOut ?? quote.minAmountOut ?? quote.minimumOutput,
    "minimum output",
  );
  const expiresAtMs =
    typeof quote.expiresAt === "string"
      ? Date.parse(quote.expiresAt)
      : Number.NaN;
  const nowMs = expected.nowMs ?? Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs)
    throw new Error("XyloNet quote has expired.");
  if (expiresAtMs > nowMs + 20 * 60 * 1_000)
    throw new Error(
      "XyloNet quote expiry exceeds the executor deadline window.",
    );

  return {
    executor,
    router,
    tokenIn,
    tokenOut,
    amountIn: expected.amountIn,
    minimumAmountOut,
    recipient,
    deadline: BigInt(Math.floor(expiresAtMs / 1_000)),
  };
}

export function verifyExternalXylonetReceipt(input: {
  receipt: {
    status: string;
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
  };
  expected: ValidatedExternalXylonetQuote & { walletAddress: Address };
}) {
  if (input.receipt.status !== "success")
    throw new Error("XyloNet swap transaction reverted.");
  for (const log of input.receipt.logs) {
    if (!sameAddress(log.address, input.expected.executor)) continue;
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: WIZPAY_SWAP_EXECUTOR_V2_ABI,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        eventName: "WizPaySwapExecuted",
      });
      const args = decoded.args;
      if (
        !sameAddress(args.user, input.expected.walletAddress) ||
        !sameAddress(args.router, input.expected.router) ||
        !sameAddress(args.tokenIn, input.expected.tokenIn) ||
        !sameAddress(args.tokenOut, input.expected.tokenOut) ||
        args.amountIn !== input.expected.amountIn ||
        !sameAddress(args.recipient, input.expected.recipient)
      )
        throw new Error("XyloNet receipt does not match the submitted swap.");
      if (args.amountOut < input.expected.minimumAmountOut)
        throw new Error("XyloNet receipt output is below the quoted minimum.");
      return args.amountOut;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("does not match") ||
          error.message.includes("below"))
      )
        throw error;
    }
  }
  throw new Error(
    "Canonical WizPaySwapExecutorV2 receipt event was not found.",
  );
}

export function createSwapSubmissionLock() {
  let active = false;
  return async <T>(run: () => Promise<T>) => {
    if (active) throw new Error("A swap submission is already in progress.");
    active = true;
    try {
      return await run();
    } finally {
      active = false;
    }
  };
}
