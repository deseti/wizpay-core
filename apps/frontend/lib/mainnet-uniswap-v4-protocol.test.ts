import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  padHex,
  parseAbi,
  parseAbiItem,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_USDC,
  ARC_NATIVE_USDC_TRANSFER_EMITTER,
  WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
  applySlippage,
  calculateMinHopPriceX36,
  deriveMainnetUniswapV4PoolId,
  encodeExecuteSwap,
  encodeUserControlledApprovals,
  mainnetUniswapV4TransactionValue,
  validateMainnetUniswapV4Quote,
  verifyMainnetUniswapV4Receipt,
} from "./mainnet-uniswap-v4-protocol";

const USER = "0x1234567890123456789012345678901234567890" as const;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const EXECUTOR_ABI = parseAbi([
  "function executeSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 minHopPriceX36, uint256 deadline) payable returns (uint256 amountOut)",
]);
const APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const SWAP_EVENT = parseAbiItem(
  "event WizPayMainnetSwapExecuted(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 feeAmount, uint256 netAmountIn, uint256 amountOut, uint256 minAmountOut)",
);

function transferLog(
  token: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
) {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      padHex(from, { size: 32 }),
      padHex(to, { size: 32 }),
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function executorSwapLog(amountOut: bigint) {
  const topics = encodeEventTopics({
    abi: [SWAP_EVENT],
    eventName: "WizPayMainnetSwapExecuted",
    args: {
      caller: USER,
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
    },
  });
  return {
    address: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
    topics: topics.filter(
      (topic): topic is `0x${string}` => topic !== null,
    ),
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [1_000_000n, 0n, 1_000_000n, amountOut, applySlippage(amountOut, 50)],
    ),
  };
}

describe("frontend Uniswap V4 protocol helpers", () => {
  it("binds the candidate PoolKey to the verified PoolId", () => {
    expect(deriveMainnetUniswapV4PoolId()).toBe(ARC_MAINNET_UNISWAP_V4_POOL_ID);
  });

  it("validates a bidirectional quote without enabling execution", () => {
    const quote = validateMainnetUniswapV4Quote({
      chainId: 5_042,
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      amountOut: "864736",
      gasEstimate: "37217",
      slippageBps: 50,
      walletControl: "external-wallet",
      recipient: USER,
      walletAddress: USER,
      deadline: 2_000_000_300,
      nowSeconds: 2_000_000_000,
    });
    expect(quote.executable).toBe(false);
    expect(quote.minAmountOut).toBe(applySlippage(864_736n, 50));
    expect(quote.zeroForOne).toBe(true);
    const reverse = validateMainnetUniswapV4Quote({
      chainId: 5_042,
      tokenIn: ARC_MAINNET_UNISWAP_V4_EURC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_USDC,
      amountIn: 87_169n,
      amountOut: "99899",
      gasEstimate: "36933",
      slippageBps: 250,
      walletControl: "external-wallet",
      recipient: USER,
      walletAddress: USER,
      deadline: 2_000_000_300,
      nowSeconds: 2_000_000_000,
    });
    expect(reverse.zeroForOne).toBe(false);
    expect(reverse.minHopPriceX36).toBe(
      1_117_387_201_872_225_217_680_597_460_106_230_425n,
    );
  });

  it("rejects custodial wallets and non-Mainnet chain IDs", () => {
    expect(() =>
      validateMainnetUniswapV4Quote({
        chainId: 5_042,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 1_000_000n,
        amountOut: "864736",
        gasEstimate: "37217",
        slippageBps: 50,
        walletControl: "custodial" as never,
        recipient: USER,
        walletAddress: USER,
        deadline: 2_000_000_300,
        nowSeconds: 2_000_000_000,
      }),
    ).toThrow(/user-controlled/);
    expect(() =>
      validateMainnetUniswapV4Quote({
        chainId: 9_999,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 1_000_000n,
        amountOut: "864736",
        gasEstimate: "37217",
        slippageBps: 50,
        walletControl: "external-wallet",
        recipient: USER,
        walletAddress: USER,
        deadline: 2_000_000_300,
        nowSeconds: 2_000_000_000,
      }),
    ).toThrow(/5042/);
    expect(() =>
      validateMainnetUniswapV4Quote({
        chainId: 5_042,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 1_000_000n,
        amountOut: "864736",
        gasEstimate: "37217",
        slippageBps: 50,
        walletControl: "circle" as never,
        recipient: USER,
        walletAddress: USER,
        deadline: 2_000_000_300,
        nowSeconds: 2_000_000_000,
      }),
    ).toThrow(/user-controlled/);
    expect(() =>
      validateMainnetUniswapV4Quote({
        chainId: 5_042,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 1_000_000n,
        amountOut: "864736",
        gasEstimate: "37217",
        slippageBps: 50,
        walletControl: "external-wallet",
        recipient: USER,
        walletAddress: USER,
        deadline: 2_000_001_201,
        nowSeconds: 2_000_000_000,
      }),
    ).toThrow(/deadline/);
  });

  it("encodes Swap Executor calldata, native USDC value, and EURC executor approval", () => {
    const approvals = encodeUserControlledApprovals({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      amountIn: 1_000_000n,
      deadline: 2_000_000_300,
    });
    expect(approvals).toHaveLength(0);
    expect(
      mainnetUniswapV4TransactionValue(ARC_MAINNET_UNISWAP_V4_USDC, 1_000_000n),
    ).toBe(1_000_000_000_000_000_000n);
    const data = encodeExecuteSwap({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      minAmountOut: applySlippage(864_736n, 50),
      minHopPriceX36: calculateMinHopPriceX36(1_000_000n, 864_736n, 50),
      deadline: 2_000_000_300,
    });
    const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data });
    expect(decoded.functionName).toBe("executeSwap");
    expect(decoded.args[0]).toBe(ARC_MAINNET_UNISWAP_V4_USDC);
    expect(WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS).toBe(
      "0x7A051F17B237750EF9D4E63fb75381B9F8755774",
    );

    const eurcApprovals = encodeUserControlledApprovals({
      tokenIn: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      deadline: 2_000_000_300,
    });
    expect(eurcApprovals).toHaveLength(1);
    expect(eurcApprovals[0]?.to).toBe(ARC_MAINNET_UNISWAP_V4_EURC);
    const approval = decodeFunctionData({
      abi: APPROVE_ABI,
      data: eurcApprovals[0]!.data,
    });
    expect(approval.args[0]).toBe(WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS);
    expect(
      mainnetUniswapV4TransactionValue(ARC_MAINNET_UNISWAP_V4_EURC, 1_000_000n),
    ).toBe(0n);
  });

  it("verifies actual Swap Executor output", () => {
    const transactionData = encodeExecuteSwap({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      minAmountOut: applySlippage(864_736n, 50),
      minHopPriceX36: calculateMinHopPriceX36(1_000_000n, 864_736n, 50),
      deadline: 2_000_000_300,
    });
    expect(
      verifyMainnetUniswapV4Receipt({
        chainId: 5_042,
        status: "success",
        from: USER,
        to: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
        transactionData,
        expectedTransactionData: transactionData,
        transactionValue: 1_000_000_000_000_000_000n,
        expectedTransactionValue: 1_000_000_000_000_000_000n,
        logs: [
          executorSwapLog(864_736n),
          transferLog(
            ARC_NATIVE_USDC_TRANSFER_EMITTER,
            USER,
            WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
            1_000_000_000_000_000_000n,
          ),
          transferLog(ARC_MAINNET_UNISWAP_V4_EURC, USER, USER, 864_736n),
        ],
        walletAddress: USER,
        recipient: USER,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 1_000_000n,
        minAmountOut: applySlippage(864_736n, 50),
      }).amountOut,
    ).toBe(864_736n);
  });
});
