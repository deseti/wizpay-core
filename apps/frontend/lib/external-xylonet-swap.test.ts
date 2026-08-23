import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WIZPAY_SWAP_EXECUTOR_V2_ABI,
  createSwapSubmissionLock,
  validateExternalXylonetQuote,
  verifyExternalXylonetReceipt,
} from "./external-xylonet-swap";
import type { UserSwapQuoteResponse } from "./user-swap-service";

const wallet = "0x90ab859240b941eaf0cbcbf42df5086e0ad54147" as Address;
const router = "0x73742278c31a76dBb0D2587d03ef92E6E2141023" as Address;
const executor = "0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed" as Address;
const usdc = "0x3600000000000000000000000000000000000000" as Address;
const eurc = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address;

function quote(
  tokenIn: "USDC" | "EURC" = "USDC",
  tokenOut: "USDC" | "EURC" = "EURC",
): UserSwapQuoteResponse {
  const input = tokenIn === "USDC" ? usdc : eurc;
  const output = tokenOut === "USDC" ? usdc : eurc;
  return {
    tokenIn,
    tokenOut,
    tokenInAddress: input,
    tokenOutAddress: output,
    amountIn: "1000000",
    fromAddress: wallet,
    toAddress: wallet,
    recipientAddress: wallet,
    chain: "ARC-TESTNET",
    chainId: 5042002,
    provider: "xylonet",
    executorAddress: executor,
    routerAddress: router,
    expectedOutput: "990000",
    minimumAmountOut: "970000",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    raw: {},
  };
}

function expected(
  tokenIn: "USDC" | "EURC" = "USDC",
  tokenOut: "USDC" | "EURC" = "EURC",
) {
  return {
    walletAddress: wallet,
    chainId: 5042002,
    tokenIn,
    tokenOut,
    tokenInAddress: tokenIn === "USDC" ? usdc : eurc,
    tokenOutAddress: tokenOut === "USDC" ? usdc : eurc,
    amountIn: 1_000_000n,
  } as const;
}

describe("external XyloNet swap validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["USDC", "EURC"],
    ["EURC", "USDC"],
  ] as const)("accepts browser-signed %s to %s quotes", (tokenIn, tokenOut) => {
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS", executor);
    expect(
      validateExternalXylonetQuote(
        quote(tokenIn, tokenOut),
        expected(tokenIn, tokenOut),
      ),
    ).toMatchObject({
      executor,
      router,
      recipient: expect.stringMatching(
        /^0x90ab859240b941eaf0cbcbf42df5086e0ad54147$/i,
      ),
    });
  });

  it.each([
    [
      "expired quote",
      { expiresAt: new Date(Date.now() - 1).toISOString() },
      /expired/,
    ],
    [
      "wallet mismatch",
      { fromAddress: "0x1111111111111111111111111111111111111111" },
      /wallet/,
    ],
    ["chain mismatch", { chainId: 1 }, /chain/],
    ["token mismatch", { tokenOut: "USDC" }, /token pair/],
    [
      "recipient mismatch",
      { recipientAddress: "0x1111111111111111111111111111111111111111" },
      /recipient/,
    ],
    [
      "executor mismatch",
      { executorAddress: "0x1111111111111111111111111111111111111111" },
      /executor/,
    ],
  ])("rejects %s", (_label, override, pattern) => {
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS", executor);
    expect(() =>
      validateExternalXylonetQuote(
        { ...quote(), ...override } as UserSwapQuoteResponse,
        expected(),
      ),
    ).toThrow(pattern as RegExp);
  });

  it("rejects duplicate in-flight submissions", async () => {
    const lock = createSwapSubmissionLock();
    let release!: () => void;
    const first = lock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(lock(async () => undefined)).rejects.toThrow(
      /already in progress/,
    );
    release();
    await first;
  });

  it("rejects a successful receipt whose output is below minimum", () => {
    vi.stubEnv("NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS", executor);
    const validated = validateExternalXylonetQuote(quote(), expected());
    const topics = encodeEventTopics({
      abi: WIZPAY_SWAP_EXECUTOR_V2_ABI,
      eventName: "WizPaySwapExecuted",
      args: { user: wallet, router, tokenIn: usdc },
    });
    const data = encodeAbiParameters(
      parseAbiParameters("address,uint256,uint256,uint256,uint256,address"),
      [eurc, 1_000_000n, 2_500n, 997_500n, 1n, wallet],
    );
    expect(() =>
      verifyExternalXylonetReceipt({
        receipt: {
          status: "success",
          logs: [{ address: executor, topics: topics as readonly Hex[], data }],
        },
        expected: { ...validated, walletAddress: wallet },
      }),
    ).toThrow(/below the quoted minimum/);
  });
});
