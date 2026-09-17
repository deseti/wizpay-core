import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  padHex,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
  ARC_MAINNET_UNISWAP_V4_USDC,
  ARC_NATIVE_USDC_TRANSFER_EMITTER,
  applySlippage,
  calculateMinHopPriceX36,
  deriveMainnetUniswapV4PoolId,
  encodeUniversalRouterExactInput,
  encodeUserControlledApprovals,
  mainnetUniswapV4TransactionValue,
  validateMainnetUniswapV4Quote,
  verifyMainnetUniswapV4Receipt,
} from "./mainnet-uniswap-v4-protocol";

const USER = "0x1234567890123456789012345678901234567890" as const;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
const SWAP_TOPIC =
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" as const;
const ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

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

function swapLog(amount0: bigint, amount1: bigint) {
  return {
    address: ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
    topics: [
      SWAP_TOPIC,
      ARC_MAINNET_UNISWAP_V4_POOL_ID,
      padHex(ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER, { size: 32 }),
    ],
    data: encodeAbiParameters(
      [
        { type: "int128" },
        { type: "int128" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
        { type: "uint24" },
      ],
      [amount0, amount1, 1n, 1n, 0, 500],
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

  it("rejects developer-controlled wallets and Testnet chain IDs", () => {
    expect(() =>
      validateMainnetUniswapV4Quote({
        chainId: 5_042,
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        amountIn: 1_000_000n,
        amountOut: "864736",
        gasEstimate: "37217",
        slippageBps: 50,
        walletControl: "developer-controlled" as never,
        recipient: USER,
        walletAddress: USER,
        deadline: 2_000_000_300,
        nowSeconds: 2_000_000_000,
      }),
    ).toThrow(/user-controlled/);
    expect(() =>
      validateMainnetUniswapV4Quote({
        chainId: 5_042_002,
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

  it("encodes Permit2 approvals and Universal Router calldata", () => {
    const approvals = encodeUserControlledApprovals({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      amountIn: 1_000_000n,
      deadline: 2_000_000_300,
    });
    expect(approvals).toHaveLength(0);
    expect(
      mainnetUniswapV4TransactionValue(ARC_MAINNET_UNISWAP_V4_USDC, 1_000_000n),
    ).toBe(1_000_000_000_000_000_000n);
    const data = encodeUniversalRouterExactInput({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      minAmountOut: applySlippage(864_736n, 50),
      minHopPriceX36: calculateMinHopPriceX36(1_000_000n, 864_736n, 50),
      recipient: USER,
      deadline: 2_000_000_300,
    });
    expect(data.startsWith("0x")).toBe(true);
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data });
    const [actions, params] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes[]" }],
      decoded.args[1][0],
    );
    expect(actions).toBe("0x070b0e");
    const [exactInput] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currencyIn", type: "address" },
            {
              name: "path",
              type: "tuple[]",
              components: [
                { name: "intermediateCurrency", type: "address" },
                { name: "fee", type: "uint24" },
                { name: "tickSpacing", type: "int24" },
                { name: "hooks", type: "address" },
                { name: "hookData", type: "bytes" },
              ],
            },
            { name: "minHopPriceX36", type: "uint256[]" },
            { name: "amountIn", type: "uint128" },
            { name: "amountOutMinimum", type: "uint128" },
          ],
        },
      ],
      params[0],
    );
    expect(exactInput.minHopPriceX36).toEqual([
      calculateMinHopPriceX36(1_000_000n, 864_736n, 50),
    ]);
    const [, recipient] = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      params[2],
    );
    expect(recipient).toBe(USER);

    const eurcApprovals = encodeUserControlledApprovals({
      tokenIn: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      deadline: 2_000_000_300,
    });
    expect(eurcApprovals).toHaveLength(2);
    expect(
      mainnetUniswapV4TransactionValue(ARC_MAINNET_UNISWAP_V4_EURC, 1_000_000n),
    ).toBe(0n);
  });

  it("verifies actual Universal Router output", () => {
    const transactionData = encodeUniversalRouterExactInput({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: 1_000_000n,
      minAmountOut: applySlippage(864_736n, 50),
      minHopPriceX36: calculateMinHopPriceX36(1_000_000n, 864_736n, 50),
      recipient: USER,
      deadline: 2_000_000_300,
    });
    expect(
      verifyMainnetUniswapV4Receipt({
        chainId: 5_042,
        status: "success",
        from: USER,
        to: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
        transactionData,
        expectedTransactionData: transactionData,
        transactionValue: 1_000_000_000_000_000_000n,
        expectedTransactionValue: 1_000_000_000_000_000_000n,
        logs: [
          swapLog(-1_000_000n, 864_736n),
          transferLog(
            ARC_NATIVE_USDC_TRANSFER_EMITTER,
            USER,
            ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
            1_000_000_000_000_000_000n,
          ),
          transferLog(
            ARC_MAINNET_UNISWAP_V4_USDC,
            ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
            ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
            1_000_000n,
          ),
          transferLog(
            ARC_MAINNET_UNISWAP_V4_EURC,
            ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
            USER,
            864_736n,
          ),
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
