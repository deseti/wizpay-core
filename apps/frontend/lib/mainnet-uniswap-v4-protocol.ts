import {
  concatHex,
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export const ARC_MAINNET_UNISWAP_V4_CHAIN_ID = 5_042 as const;
export const ARC_MAINNET_UNISWAP_V4_USDC =
  "0x3600000000000000000000000000000000000000" as const;
export const ARC_MAINNET_UNISWAP_V4_EURC =
  "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" as const;
export const ARC_MAINNET_UNISWAP_V4_POOL_ID =
  "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae" as const;
export const ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER =
  "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1" as const;
export const ARC_MAINNET_UNISWAP_V4_PERMIT2 =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
export const ARC_MAINNET_UNISWAP_V4_QUOTER =
  "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as const;
export const ARC_MAINNET_UNISWAP_V4_POOL_MANAGER =
  "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
export const ARC_NATIVE_USDC_TRANSFER_EMITTER =
  "0xfffffffffffffffffffffffffffffffffffffffe" as const;
export const ARC_MAINNET_USDC_NATIVE_SCALE = 1_000_000_000_000n;

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;
const PATH_KEY_COMPONENTS = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;

// WizPaySwapExecutorMainnet — not yet deployed; executable=false.
// When deployed, this address will be set to the verified contract address.
// Until then, the direct external-wallet flow via UniversalRouter is used.
export const WIZPAY_SWAP_EXECUTOR_MAINNET_EXECUTABLE = false as const;

export const ARC_MAINNET_UNISWAP_V4_POOL_KEY = Object.freeze({
  currency0: ARC_MAINNET_UNISWAP_V4_USDC,
  currency1: ARC_MAINNET_UNISWAP_V4_EURC,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
});

const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);
const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const PERMIT2_APPROVE_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

export type MainnetUniswapV4WalletControl = "external-wallet";

export function deriveMainnetUniswapV4PoolId() {
  return keccak256(
    encodeAbiParameters(
      [{ name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS }],
      [ARC_MAINNET_UNISWAP_V4_POOL_KEY],
    ),
  );
}

export function applySlippage(amountOut: bigint, slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
    throw new Error("slippageBps must be an integer between 1 and 500.");
  }
  const minAmountOut = (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
  if (minAmountOut <= 0n) {
    throw new Error("Slippage-adjusted minimum output must be positive.");
  }
  return minAmountOut;
}

export function calculateMinHopPriceX36(
  amountIn: bigint,
  amountOut: bigint,
  slippageBps: number,
) {
  if (amountIn <= 0n) throw new Error("amountIn must be positive.");
  applySlippage(amountOut, slippageBps);
  const result =
    (amountOut * (10_000n - BigInt(slippageBps)) * 10n ** 36n) /
    (amountIn * 10_000n);
  if (result <= 0n)
    throw new Error("Slippage-adjusted per-hop price floor must be positive.");
  return result;
}

export function zeroForOneFromTokens(tokenIn: Address, tokenOut: Address) {
  if (
    isAddressEqual(tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
    isAddressEqual(tokenOut, ARC_MAINNET_UNISWAP_V4_EURC)
  ) {
    return true;
  }
  if (
    isAddressEqual(tokenIn, ARC_MAINNET_UNISWAP_V4_EURC) &&
    isAddressEqual(tokenOut, ARC_MAINNET_UNISWAP_V4_USDC)
  ) {
    return false;
  }
  throw new Error(
    "Only the candidate Arc Mainnet USDC/EURC pair is supported.",
  );
}

function packedBytes(values: readonly number[]): Hex {
  return concatHex(values.map((value) => numberToHex(value, { size: 1 })));
}

export function encodeUniversalRouterExactInput(input: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  minHopPriceX36: bigint;
  recipient: Address;
  deadline: number;
}): Hex {
  zeroForOneFromTokens(input.tokenIn, input.tokenOut);
  const actions = packedBytes([0x07, 0x0b, 0x0e]);
  const exactIn = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currencyIn", type: "address" },
          { name: "path", type: "tuple[]", components: PATH_KEY_COMPONENTS },
          { name: "minHopPriceX36", type: "uint256[]" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
        ],
      },
    ],
    [
      {
        currencyIn: input.tokenIn,
        path: [
          {
            intermediateCurrency: input.tokenOut,
            fee: 500,
            tickSpacing: 10,
            hooks: zeroAddress,
            hookData: "0x",
          },
        ],
        minHopPriceX36: [input.minHopPriceX36],
        amountIn: input.amountIn,
        amountOutMinimum: input.minAmountOut,
      },
    ],
  );
  const v4SwapInput = encodeAbiParameters(
    [
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" },
    ],
    [
      actions,
      [
        exactIn,
        encodeAbiParameters(
          [
            { name: "currency", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "payerIsUser", type: "bool" },
          ],
          [
            input.tokenIn,
            0n,
            !isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC),
          ],
        ),
        encodeAbiParameters(
          [
            { name: "currency", type: "address" },
            { name: "recipient", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          [input.tokenOut, input.recipient, 0n],
        ),
      ],
    ],
  );
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [packedBytes([0x10]), [v4SwapInput], BigInt(input.deadline)],
  });
}

export function encodeUserControlledApprovals(input: {
  tokenIn: Address;
  amountIn: bigint;
  deadline: number;
}) {
  if (isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC)) {
    return Object.freeze([]);
  }
  if (!isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_EURC)) {
    throw new Error("Permit2 approvals are only valid for EURC input.");
  }
  return Object.freeze([
    Object.freeze({
      to: input.tokenIn,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [ARC_MAINNET_UNISWAP_V4_PERMIT2, input.amountIn],
      }),
      description: "Approve Permit2 to spend the input token.",
    }),
    Object.freeze({
      to: ARC_MAINNET_UNISWAP_V4_PERMIT2,
      data: encodeFunctionData({
        abi: PERMIT2_APPROVE_ABI,
        functionName: "approve",
        args: [
          input.tokenIn,
          ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
          input.amountIn,
          input.deadline,
        ],
      }),
      description: "Approve Universal Router through Permit2.",
    }),
  ]);
}

export function validateMainnetUniswapV4Quote(input: {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: string;
  gasEstimate: string;
  slippageBps: number;
  walletControl: MainnetUniswapV4WalletControl;
  recipient: Address;
  walletAddress: Address;
  deadline: number;
  nowSeconds?: number;
}) {
  if (input.chainId !== ARC_MAINNET_UNISWAP_V4_CHAIN_ID) {
    throw new Error("chainId must be Arc Mainnet (5042).");
  }
  if (input.walletControl !== "external-wallet") {
    throw new Error("Only user-controlled wallets may swap on Arc Mainnet.");
  }
  if (!isAddressEqual(input.recipient, input.walletAddress)) {
    throw new Error("recipient must equal the user-controlled wallet address.");
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(input.deadline) ||
    input.deadline <= nowSeconds ||
    input.deadline > nowSeconds + 1_200
  ) {
    throw new Error("deadline must be in the next 1200 seconds.");
  }
  if (
    !/^[1-9]\d*$/.test(input.amountOut) ||
    !/^[1-9]\d*$/.test(input.gasEstimate)
  ) {
    throw new Error("Quote amountOut and gasEstimate must be canonical.");
  }
  const amountOut = BigInt(input.amountOut);
  if (input.amountIn <= 0n) throw new Error("amountIn must be positive.");
  return Object.freeze({
    zeroForOne: zeroForOneFromTokens(input.tokenIn, input.tokenOut),
    amountOut,
    gasEstimate: BigInt(input.gasEstimate),
    minAmountOut: applySlippage(amountOut, input.slippageBps),
    minHopPriceX36: calculateMinHopPriceX36(
      input.amountIn,
      amountOut,
      input.slippageBps,
    ),
    poolId: deriveMainnetUniswapV4PoolId(),
    executable: false as const,
  });
}

export function mainnetUniswapV4TransactionValue(
  tokenIn: Address,
  amountIn: bigint,
) {
  if (amountIn <= 0n) throw new Error("amountIn must be positive.");
  return isAddressEqual(tokenIn, ARC_MAINNET_UNISWAP_V4_USDC)
    ? amountIn * ARC_MAINNET_USDC_NATIVE_SCALE
    : 0n;
}

export function verifyMainnetUniswapV4Receipt(input: {
  chainId: number;
  status: "success" | "reverted" | number;
  from: string;
  to: string;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
  transactionData: Hex;
  expectedTransactionData: Hex;
  transactionValue: bigint;
  expectedTransactionValue: bigint;
  walletAddress: Address;
  recipient: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
}) {
  if (!isAddressEqual(input.walletAddress, input.recipient)) {
    throw new Error("recipient must equal the initiating external wallet.");
  }
  if (
    input.chainId !== ARC_MAINNET_UNISWAP_V4_CHAIN_ID ||
    (input.status !== "success" && input.status !== 1) ||
    !isAddressEqual(getAddress(input.from), input.walletAddress) ||
    !isAddressEqual(
      getAddress(input.to),
      ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
    ) ||
    input.transactionData.toLowerCase() !==
      input.expectedTransactionData.toLowerCase() ||
    input.transactionValue !== input.expectedTransactionValue
  ) {
    throw new Error(
      "Swap receipt is not a successful Arc Mainnet Universal Router swap.",
    );
  }
  let tokenInSpent = 0n;
  let amountOut = 0n;
  let nativeInputTransferred = 0n;
  let poolInput = 0n;
  let poolOutput = 0n;
  let matchingPoolSwaps = 0;
  const swapTopic =
    "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
  const zeroForOne = zeroForOneFromTokens(input.tokenIn, input.tokenOut);
  for (const log of input.logs) {
    if (!isAddress(log.address)) continue;
    if (
      log.topics[0]?.toLowerCase() === swapTopic &&
      isAddressEqual(
        getAddress(log.address),
        ARC_MAINNET_UNISWAP_V4_POOL_MANAGER,
      ) &&
      log.topics[1]?.toLowerCase() === ARC_MAINNET_UNISWAP_V4_POOL_ID &&
      /^0x[0-9a-fA-F]{64}$/.test(log.topics[2] ?? "") &&
      isAddressEqual(
        getAddress(`0x${log.topics[2].slice(-40)}`),
        ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
      )
    ) {
      try {
        const [amount0, amount1, , , , fee] = decodeAbiParameters(
          [
            { type: "int128" },
            { type: "int128" },
            { type: "uint160" },
            { type: "uint128" },
            { type: "int24" },
            { type: "uint24" },
          ],
          log.data as Hex,
        );
        const inputDelta = zeroForOne ? amount0 : amount1;
        const outputDelta = zeroForOne ? amount1 : amount0;
        if (inputDelta < 0n && outputDelta > 0n && fee === 500) {
          matchingPoolSwaps += 1;
          poolInput += -inputDelta;
          poolOutput += outputDelta;
        }
      } catch {
        // Ignore malformed logs; the exact required event is checked below.
      }
      continue;
    }
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
    } catch {
      continue;
    }
    if (decoded.eventName !== "Transfer") continue;
    if (
      isAddressEqual(getAddress(log.address), input.tokenIn) &&
      ((isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
        isAddressEqual(
          decoded.args.from,
          ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
        )) ||
        (!isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
          isAddressEqual(decoded.args.from, input.walletAddress))) &&
      isAddressEqual(decoded.args.to, ARC_MAINNET_UNISWAP_V4_POOL_MANAGER)
    ) {
      tokenInSpent += decoded.args.value;
    }
    if (
      isAddressEqual(
        getAddress(log.address),
        ARC_NATIVE_USDC_TRANSFER_EMITTER,
      ) &&
      isAddressEqual(decoded.args.from, input.walletAddress) &&
      isAddressEqual(decoded.args.to, ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER)
    ) {
      nativeInputTransferred += decoded.args.value;
    }
    if (
      isAddressEqual(getAddress(log.address), input.tokenOut) &&
      isAddressEqual(decoded.args.from, ARC_MAINNET_UNISWAP_V4_POOL_MANAGER) &&
      isAddressEqual(decoded.args.to, input.recipient)
    ) {
      amountOut += decoded.args.value;
    }
  }
  if (
    matchingPoolSwaps !== 1 ||
    poolInput !== input.amountIn ||
    poolOutput !== amountOut ||
    tokenInSpent !== input.amountIn ||
    amountOut < input.minAmountOut ||
    (isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
      nativeInputTransferred !== input.expectedTransactionValue)
  ) {
    throw new Error("Actual swap output does not satisfy the quoted bounds.");
  }
  return Object.freeze({ amountOut, tokenInSpent });
}
