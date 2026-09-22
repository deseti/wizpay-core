import {
  concatHex,
  decodeFunctionResult,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  decodeAbiParameters,
  decodeEventLog,
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
} from 'viem';
import type {
  MainnetUniswapV4WalletControl,
  NormalizedMainnetUniswapV4BoundaryRequest,
} from './mainnet-uniswap-v4-readiness.service';

export const ARC_MAINNET_UNISWAP_V4_USDC =
  '0x3600000000000000000000000000000000000000' as const;
export const ARC_MAINNET_UNISWAP_V4_EURC =
  '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' as const;
export const ARC_MAINNET_UNISWAP_V4_HOOKS = zeroAddress;
export const ARC_MAINNET_UNISWAP_V4_FEE = 500 as const;
export const ARC_MAINNET_UNISWAP_V4_TICK_SPACING = 10 as const;
export const ARC_MAINNET_UNISWAP_V4_POOL_ID =
  '0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae' as const;
export const ARC_MAINNET_UNISWAP_V4_POOL_MANAGER =
  '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;
export const ARC_MAINNET_UNISWAP_V4_QUOTER =
  '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as const;
export const ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER =
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1' as const;
export const ARC_MAINNET_UNISWAP_V4_PERMIT2 =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const ARC_MAINNET_USDC_NATIVE_SCALE = 1_000_000_000_000n;
export const ARC_NATIVE_USDC_TRANSFER_EMITTER =
  '0xfffffffffffffffffffffffffffffffffffffffe' as const;
export const ARC_MAINNET_UNISWAP_V4_COMMANDS = Object.freeze({
  PERMIT2_PERMIT: 0x0a,
  V4_SWAP: 0x10,
});
export const ARC_MAINNET_UNISWAP_V4_ACTIONS = Object.freeze({
  SWAP_EXACT_IN: 0x07,
  SETTLE: 0x0b,
  TAKE: 0x0e,
});

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

const PATH_KEY_COMPONENTS = [
  { name: 'intermediateCurrency', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
  { name: 'hookData', type: 'bytes' },
] as const;

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline)',
]);

const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const PERMIT2_APPROVE_ABI = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

export type MainnetUniswapV4PoolKey = Readonly<{
  currency0: typeof ARC_MAINNET_UNISWAP_V4_USDC;
  currency1: typeof ARC_MAINNET_UNISWAP_V4_EURC;
  fee: typeof ARC_MAINNET_UNISWAP_V4_FEE;
  tickSpacing: typeof ARC_MAINNET_UNISWAP_V4_TICK_SPACING;
  hooks: typeof ARC_MAINNET_UNISWAP_V4_HOOKS;
}>;

export const WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS =
  '0x7A051F17B237750EF9D4E63fb75381B9F8755774' as const;
export const WIZPAY_SWAP_EXECUTOR_MAINNET_EXECUTABLE = true as const;

const EXECUTE_SWAP_ABI = parseAbi([
  'function executeSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 minHopPriceX36, uint256 deadline) payable returns (uint256 amountOut)',
]);

export function decodeExecuteSwap(data: Hex) {
  const decoded = decodeFunctionData({ abi: EXECUTE_SWAP_ABI, data });
  if (decoded.functionName !== 'executeSwap') {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Transaction calldata is not an executor swap.',
    );
  }
  const [tokenIn, tokenOut, amountIn, minAmountOut, minHopPriceX36, deadline] =
    decoded.args;
  zeroForOneFromTokens(tokenIn, tokenOut);
  return {
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    minHopPriceX36,
    deadline,
  };
}
const SWAP_EXECUTED_EVENT = parseAbiItem(
  'event WizPayMainnetSwapExecuted(address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 feeAmount, uint256 netAmountIn, uint256 amountOut, uint256 minAmountOut)',
);

export const ARC_MAINNET_UNISWAP_V4_POOL_KEY: MainnetUniswapV4PoolKey =
  Object.freeze({
    currency0: ARC_MAINNET_UNISWAP_V4_USDC,
    currency1: ARC_MAINNET_UNISWAP_V4_EURC,
    fee: ARC_MAINNET_UNISWAP_V4_FEE,
    tickSpacing: ARC_MAINNET_UNISWAP_V4_TICK_SPACING,
    hooks: ARC_MAINNET_UNISWAP_V4_HOOKS,
  });

export type MainnetUniswapV4QuoteObservation = Readonly<{
  chainId: number;
  quoterAddress: string;
  poolId: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: string;
  blockNumber: number;
  amountOut: string;
  gasEstimate: string;
}>;

export type MainnetUniswapV4ValidatedQuote = Readonly<{
  zeroForOne: boolean;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
  minAmountOut: bigint;
  minHopPriceX36: bigint;
  slippageBps: number;
  poolId: typeof ARC_MAINNET_UNISWAP_V4_POOL_ID;
}>;

export type MainnetUniswapV4Call = Readonly<{
  to: Address;
  data: Hex;
  value: bigint;
  description: string;
}>;

export type MainnetUniswapV4SwapPlan = Readonly<{
  walletControl: MainnetUniswapV4WalletControl;
  chainId: 5_042;
  poolKey: MainnetUniswapV4PoolKey;
  poolId: typeof ARC_MAINNET_UNISWAP_V4_POOL_ID;
  quote: MainnetUniswapV4ValidatedQuote;
  approvals: readonly MainnetUniswapV4Call[];
  swap: MainnetUniswapV4Call;
  permit2: Readonly<{
    token: Address;
    spender: typeof ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER;
    amount: bigint;
    expiration: number;
  }> | null;
  recipient: Address;
  deadline: number;
  executable: false;
}>;

export type MainnetUniswapV4ReceiptLog = Readonly<{
  address: string;
  topics: readonly string[];
  data: string;
}>;

export type MainnetUniswapV4Receipt = Readonly<{
  chainId: number;
  status: 'success' | 'reverted' | number;
  from: string;
  to: string;
  input: string;
  value: string;
  logs: readonly MainnetUniswapV4ReceiptLog[];
}>;

export class MainnetUniswapV4ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MainnetUniswapV4ProtocolError';
  }
}

export function deriveMainnetUniswapV4PoolId(
  poolKey: MainnetUniswapV4PoolKey = ARC_MAINNET_UNISWAP_V4_POOL_KEY,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS }],
      [poolKey],
    ),
  );
}

export function assertCandidatePoolKeyMatchesEvidence(poolId: string) {
  const derived = deriveMainnetUniswapV4PoolId();
  if (
    derived !== ARC_MAINNET_UNISWAP_V4_POOL_ID ||
    poolId.toLowerCase() !== ARC_MAINNET_UNISWAP_V4_POOL_ID
  ) {
    throw new MainnetUniswapV4ProtocolError(
      'POOL_ID_MISMATCH',
      'Candidate PoolId does not match the canonical USDC/EURC PoolKey.',
    );
  }
  return derived;
}

export function zeroForOneFromTokens(
  tokenIn: Address,
  tokenOut: Address,
): boolean {
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
  throw new MainnetUniswapV4ProtocolError(
    'UNSUPPORTED_PAIR',
    'Only the candidate Arc Mainnet USDC/EURC pair is supported.',
  );
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_SLIPPAGE',
      'slippageBps must be an integer between 1 and 500.',
    );
  }
  const minAmountOut = (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
  if (minAmountOut <= 0n) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_QUOTE',
      'Slippage-adjusted minimum output must be positive.',
    );
  }
  return minAmountOut;
}

export function calculateMinHopPriceX36(
  amountIn: bigint,
  amountOut: bigint,
  slippageBps: number,
): bigint {
  if (amountIn <= 0n) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_QUOTE',
      'amountIn must be positive when calculating the per-hop price floor.',
    );
  }
  applySlippage(amountOut, slippageBps);
  const minHopPriceX36 =
    (amountOut * (10_000n - BigInt(slippageBps)) * 10n ** 36n) /
    (amountIn * 10_000n);
  if (minHopPriceX36 <= 0n) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_QUOTE',
      'Slippage-adjusted per-hop price floor must be positive.',
    );
  }
  return minHopPriceX36;
}

function requireCanonicalUint(value: string, label: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_QUOTE',
      `${label} must be a canonical positive integer string.`,
    );
  }
  return BigInt(value);
}

export function encodeQuoteExactInputSingle(request: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}): Hex {
  const zeroForOne = zeroForOneFromTokens(request.tokenIn, request.tokenOut);
  return encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        poolKey: ARC_MAINNET_UNISWAP_V4_POOL_KEY,
        zeroForOne,
        exactAmount: request.amountIn,
        hookData: '0x',
      },
    ],
  });
}

export function decodeQuoteExactInputSingleResult(data: Hex): {
  amountOut: bigint;
  gasEstimate: bigint;
} {
  const [amountOut, gasEstimate] = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    data,
  });
  return { amountOut, gasEstimate };
}

export function validateQuoteObservation(
  request: NormalizedMainnetUniswapV4BoundaryRequest,
  observation: MainnetUniswapV4QuoteObservation,
): MainnetUniswapV4ValidatedQuote {
  if (
    observation.chainId !== 5_042 ||
    !isAddress(observation.quoterAddress) ||
    !isAddressEqual(observation.quoterAddress, ARC_MAINNET_UNISWAP_V4_QUOTER) ||
    !/^0x[0-9a-fA-F]{64}$/.test(observation.poolId) ||
    observation.poolId.toLowerCase() !== ARC_MAINNET_UNISWAP_V4_POOL_ID ||
    !isAddress(observation.tokenInAddress) ||
    !isAddress(observation.tokenOutAddress) ||
    !isAddressEqual(observation.tokenInAddress, request.tokenInAddress) ||
    !isAddressEqual(observation.tokenOutAddress, request.tokenOutAddress) ||
    observation.amountIn !== request.amountIn.toString() ||
    !Number.isSafeInteger(observation.blockNumber) ||
    observation.blockNumber <= 0
  ) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_QUOTE',
      'Quote observation does not match the canonical Arc Mainnet request.',
    );
  }
  const amountOut = requireCanonicalUint(observation.amountOut, 'amountOut');
  const gasEstimate = requireCanonicalUint(
    observation.gasEstimate,
    'gasEstimate',
  );
  const minAmountOut = applySlippage(amountOut, request.slippageBps);
  const minHopPriceX36 = calculateMinHopPriceX36(
    request.amountIn,
    amountOut,
    request.slippageBps,
  );
  return Object.freeze({
    zeroForOne: zeroForOneFromTokens(
      request.tokenInAddress,
      request.tokenOutAddress,
    ),
    tokenIn: request.tokenInAddress,
    tokenOut: request.tokenOutAddress,
    amountIn: request.amountIn,
    amountOut,
    gasEstimate,
    minAmountOut,
    minHopPriceX36,
    slippageBps: request.slippageBps,
    poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
  });
}

function packedBytes(values: readonly number[]): Hex {
  return concatHex(values.map((value) => numberToHex(value, { size: 1 })));
}

function encodeExactInputParams(quote: MainnetUniswapV4ValidatedQuote): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'currencyIn', type: 'address' },
          { name: 'path', type: 'tuple[]', components: PATH_KEY_COMPONENTS },
          { name: 'minHopPriceX36', type: 'uint256[]' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
        ],
      },
    ],
    [
      {
        currencyIn: quote.tokenIn,
        path: [
          {
            intermediateCurrency: quote.tokenOut,
            fee: ARC_MAINNET_UNISWAP_V4_FEE,
            tickSpacing: ARC_MAINNET_UNISWAP_V4_TICK_SPACING,
            hooks: ARC_MAINNET_UNISWAP_V4_HOOKS,
            hookData: '0x',
          },
        ],
        minHopPriceX36: [quote.minHopPriceX36],
        amountIn: quote.amountIn,
        amountOutMinimum: quote.minAmountOut,
      },
    ],
  );
}

function encodeSettle(currency: Address, payerIsUser: boolean): Hex {
  return encodeAbiParameters(
    [
      { name: 'currency', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'payerIsUser', type: 'bool' },
    ],
    [currency, 0n, payerIsUser],
  );
}

function encodeTake(currency: Address, recipient: Address): Hex {
  return encodeAbiParameters(
    [
      { name: 'currency', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    [currency, recipient, 0n],
  );
}

export function encodeV4SwapInput(
  quote: MainnetUniswapV4ValidatedQuote,
  recipient: Address,
): Hex {
  const actions = packedBytes([
    ARC_MAINNET_UNISWAP_V4_ACTIONS.SWAP_EXACT_IN,
    ARC_MAINNET_UNISWAP_V4_ACTIONS.SETTLE,
    ARC_MAINNET_UNISWAP_V4_ACTIONS.TAKE,
  ]);
  return encodeAbiParameters(
    [
      { name: 'actions', type: 'bytes' },
      { name: 'params', type: 'bytes[]' },
    ],
    [
      actions,
      [
        encodeExactInputParams(quote),
        encodeSettle(
          quote.tokenIn,
          !isAddressEqual(quote.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC),
        ),
        encodeTake(quote.tokenOut, recipient),
      ],
    ],
  );
}

export function encodeUniversalRouterExactInput(
  quote: MainnetUniswapV4ValidatedQuote,
  recipient: Address,
  deadline: number,
): Hex {
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [
      packedBytes([ARC_MAINNET_UNISWAP_V4_COMMANDS.V4_SWAP]),
      [encodeV4SwapInput(quote, recipient)],
      BigInt(deadline),
    ],
  });
}

export function encodeExecuteSwap(input: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  minHopPriceX36: bigint;
  deadline: number;
}): Hex {
  zeroForOneFromTokens(input.tokenIn, input.tokenOut);
  return encodeFunctionData({
    abi: EXECUTE_SWAP_ABI,
    functionName: 'executeSwap',
    args: [
      input.tokenIn,
      input.tokenOut,
      input.amountIn,
      input.minAmountOut,
      input.minHopPriceX36,
      BigInt(input.deadline),
    ],
  });
}

export function encodeErc20ApproveExecutor(amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS, amount],
  });
}

export function encodeErc20ApprovePermit2(amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [ARC_MAINNET_UNISWAP_V4_PERMIT2, amount],
  });
}

export function encodePermit2ApproveRouter(
  token: Address,
  amount: bigint,
  expiration: number,
): Hex {
  return encodeFunctionData({
    abi: PERMIT2_APPROVE_ABI,
    functionName: 'approve',
    args: [token, ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER, amount, expiration],
  });
}

export function encodePermit2PermitAndSwap(input: {
  quote: MainnetUniswapV4ValidatedQuote;
  recipient: Address;
  deadline: number;
  nonce: number;
  signature: Hex;
}): Hex {
  const permitSingle = {
    details: {
      token: input.quote.tokenIn,
      amount: input.quote.amountIn,
      expiration: input.deadline,
      nonce: input.nonce,
    },
    spender: ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER,
    sigDeadline: BigInt(input.deadline),
  };
  const permitInput = encodeAbiParameters(
    [
      {
        name: 'permitSingle',
        type: 'tuple',
        components: [
          {
            name: 'details',
            type: 'tuple',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint160' },
              { name: 'expiration', type: 'uint48' },
              { name: 'nonce', type: 'uint48' },
            ],
          },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    [permitSingle, input.signature],
  );
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [
      packedBytes([
        ARC_MAINNET_UNISWAP_V4_COMMANDS.PERMIT2_PERMIT,
        ARC_MAINNET_UNISWAP_V4_COMMANDS.V4_SWAP,
      ]),
      [permitInput, encodeV4SwapInput(input.quote, input.recipient)],
      BigInt(input.deadline),
    ],
  });
}

export function buildPermit2TypedData(input: {
  token: Address;
  amount: bigint;
  spender: Address;
  nonce: number;
  deadline: number;
}) {
  if (!isAddressEqual(input.token, ARC_MAINNET_UNISWAP_V4_EURC)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_PERMIT2_TOKEN',
      'Permit2 is only used for ERC-20 EURC input on Arc Mainnet.',
    );
  }
  if (!isAddressEqual(input.spender, ARC_MAINNET_UNISWAP_V4_UNIVERSAL_ROUTER)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_PERMIT2_SPENDER',
      'Permit2 spender must be the published Universal Router.',
    );
  }
  return Object.freeze({
    domain: Object.freeze({
      name: 'Permit2',
      chainId: 5_042,
      verifyingContract: ARC_MAINNET_UNISWAP_V4_PERMIT2,
    }),
    types: Object.freeze({
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    }),
    primaryType: 'PermitSingle' as const,
    message: Object.freeze({
      details: Object.freeze({
        token: input.token,
        amount: input.amount,
        expiration: input.deadline,
        nonce: input.nonce,
      }),
      spender: input.spender,
      sigDeadline: BigInt(input.deadline),
    }),
  });
}

export function buildUserControlledSwapPlan(
  request: NormalizedMainnetUniswapV4BoundaryRequest,
  observation: MainnetUniswapV4QuoteObservation,
): MainnetUniswapV4SwapPlan {
  assertCandidatePoolKeyMatchesEvidence(ARC_MAINNET_UNISWAP_V4_POOL_ID);
  const quote = validateQuoteObservation(request, observation);
  const usesNativeUsdc = isAddressEqual(
    quote.tokenIn,
    ARC_MAINNET_UNISWAP_V4_USDC,
  );
  const transactionValue = usesNativeUsdc
    ? quote.amountIn * ARC_MAINNET_USDC_NATIVE_SCALE
    : 0n;
  return Object.freeze({
    walletControl: request.walletControl,
    chainId: 5_042,
    poolKey: ARC_MAINNET_UNISWAP_V4_POOL_KEY,
    poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
    quote,
    approvals: Object.freeze(
      usesNativeUsdc
        ? []
        : [
            Object.freeze({
              to: quote.tokenIn,
              data: encodeErc20ApproveExecutor(quote.amountIn),
              value: 0n,
              description: 'Approve WizPaySwapExecutorMainnet to spend EURC.',
            }),
          ],
    ),
    swap: Object.freeze({
      to: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
      data: encodeExecuteSwap({
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.amountIn,
        minAmountOut: quote.minAmountOut,
        minHopPriceX36: quote.minHopPriceX36,
        deadline: request.deadline,
      }),
      value: transactionValue,
      description: 'Execute the WizPaySwapExecutorMainnet USDC/EURC swap.',
    }),
    permit2: null,
    recipient: request.recipient,
    deadline: request.deadline,
    executable: false,
  });
}

function requireAddress(value: string, label: string): Address {
  if (!isAddress(value) || isAddressEqual(value, zeroAddress)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      `${label} must be a non-zero address.`,
    );
  }
  return getAddress(value);
}

export function verifySwapReceipt(
  receipt: MainnetUniswapV4Receipt,
  expected: {
    walletAddress: Address;
    recipient: Address;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    minAmountOut: bigint;
    transactionData: Hex;
    transactionValue: bigint;
    zeroForOne: boolean;
  },
): Readonly<{ amountOut: bigint; tokenInSpent: bigint }> {
  if (!isAddressEqual(expected.walletAddress, expected.recipient)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Expected recipient must equal the initiating external wallet.',
    );
  }
  if (receipt.chainId !== 5_042) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Receipt chain ID must be Arc Mainnet (5042).',
    );
  }
  if (receipt.status !== 'success' && receipt.status !== 1) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Swap receipt did not succeed.',
    );
  }
  const from = requireAddress(receipt.from, 'receipt.from');
  const to = requireAddress(receipt.to, 'receipt.to');
  if (!isAddressEqual(from, expected.walletAddress)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Receipt sender must be the user-controlled wallet.',
    );
  }
  if (!isAddressEqual(to, WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS)) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Receipt target must be WizPaySwapExecutorMainnet.',
    );
  }
  if (
    receipt.input.toLowerCase() !== expected.transactionData.toLowerCase() ||
    !/^\d+$/.test(receipt.value) ||
    BigInt(receipt.value) !== expected.transactionValue
  ) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Receipt transaction data or native value does not match the prepared swap.',
    );
  }

  const transferTopic =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  let tokenInSpent = 0n;
  let amountOut = 0n;
  let nativeInputTransferred = 0n;
  let executorEvents = 0;
  let eventAmountOut = 0n;
  for (const log of receipt.logs) {
    if (!isAddress(log.address)) continue;
    const address = getAddress(log.address);
    if (isAddressEqual(address, WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS)) {
      try {
        const decoded = decodeEventLog({
          abi: [SWAP_EXECUTED_EVENT],
          data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (
          decoded.eventName === 'WizPayMainnetSwapExecuted' &&
          isAddressEqual(decoded.args.caller, expected.walletAddress) &&
          isAddressEqual(decoded.args.tokenIn, expected.tokenIn) &&
          isAddressEqual(decoded.args.tokenOut, expected.tokenOut) &&
          decoded.args.amountIn === expected.amountIn &&
          decoded.args.amountOut >= expected.minAmountOut
        ) {
          executorEvents += 1;
          eventAmountOut = decoded.args.amountOut;
        }
      } catch {
        continue;
      }
    }
    if (log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== transferTopic) continue;
    if (
      !/^0x[0-9a-fA-F]{64}$/.test(log.topics[1] ?? '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(log.topics[2] ?? '')
    ) {
      continue;
    }
    const transferFrom = getAddress(`0x${log.topics[1].slice(-40)}`);
    const transferTo = getAddress(`0x${log.topics[2].slice(-40)}`);
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) continue;
    const value = BigInt(log.data);
    if (
      isAddressEqual(address, expected.tokenIn) &&
      isAddressEqual(transferFrom, expected.walletAddress) &&
      isAddressEqual(transferTo, WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS)
    ) {
      tokenInSpent += value;
    }
    if (
      isAddressEqual(address, ARC_NATIVE_USDC_TRANSFER_EMITTER) &&
      isAddressEqual(transferFrom, expected.walletAddress) &&
      isAddressEqual(transferTo, WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS)
    ) {
      nativeInputTransferred += value;
    }
    if (
      isAddressEqual(address, expected.tokenOut) &&
      isAddressEqual(transferTo, expected.recipient)
    ) {
      amountOut += value;
    }
  }

  if (isAddressEqual(expected.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC)) {
    tokenInSpent = expected.amountIn;
  }
  if (executorEvents !== 1 || eventAmountOut < expected.minAmountOut) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Swap Executor event evidence does not match the expected swap.',
    );
  }
  if (
    !isAddressEqual(expected.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
    tokenInSpent !== expected.amountIn
  ) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Actual input spent does not match the quoted amountIn.',
    );
  }
  if (
    isAddressEqual(expected.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
    nativeInputTransferred !== expected.transactionValue
  ) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Native USDC transfer does not match the transaction value.',
    );
  }
  if (amountOut < expected.minAmountOut) {
    throw new MainnetUniswapV4ProtocolError(
      'INVALID_RECEIPT',
      'Actual output is below the slippage-protected minimum.',
    );
  }
  return Object.freeze({ amountOut: eventAmountOut, tokenInSpent });
}
