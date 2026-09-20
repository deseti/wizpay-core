import { WIZPAY_MAINNET_V2_ABI } from "@/constants/generated/wizpay-mainnet-v2.abi";
import { WIZPAY_PAYROLL_MAINNET_ABI } from "@/constants/generated/wizpay-payroll-mainnet.abi";
import { WIZPAY_SWAP_EXECUTOR_MAINNET_ABI } from "@/constants/generated/wizpay-swap-executor-mainnet.abi";

export const WIZPAY_BATCH_PAYMENT_ROUTED_EVENT = {
  anonymous: false,
  inputs: [
    { indexed: true, internalType: "address", name: "sender", type: "address" },
    {
      indexed: false,
      internalType: "address",
      name: "tokenIn",
      type: "address",
    },
    {
      indexed: false,
      internalType: "address",
      name: "tokenOut",
      type: "address",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "totalAmountIn",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "totalAmountOut",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "totalFees",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "recipientCount",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "string",
      name: "referenceId",
      type: "string",
    },
  ],
  name: "BatchPaymentRouted",
  type: "event",
} as const;

export const WIZPAY_DIRECT_USDC_PAYMENT_EVENT = {
  anonymous: false,
  inputs: [
    {
      indexed: true,
      internalType: "bytes32",
      name: "referenceHash",
      type: "bytes32",
    },
    { indexed: true, internalType: "address", name: "payer", type: "address" },
    {
      indexed: true,
      internalType: "address",
      name: "recipient",
      type: "address",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "paymentIndex",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "grossAmount",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "netAmount",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "feeAmount",
      type: "uint256",
    },
  ],
  name: "DirectUsdcPayment",
  type: "event",
} as const;

export const WIZPAY_PAYROLL_REFERENCE_CONSUMED_EVENT = {
  anonymous: false,
  inputs: [
    {
      indexed: true,
      internalType: "bytes32",
      name: "referenceHash",
      type: "bytes32",
    },
    { indexed: true, internalType: "address", name: "payer", type: "address" },
    { indexed: true, internalType: "address", name: "token", type: "address" },
    {
      indexed: false,
      internalType: "bytes32",
      name: "batchDigest",
      type: "bytes32",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "totalAmount",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "totalOut",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "totalFees",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "recipientCount",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "string",
      name: "referenceId",
      type: "string",
    },
  ],
  name: "PayrollReferenceConsumed",
  type: "event",
} as const;

/** Arc Testnet legacy ABI. It intentionally retains the legacy FX read surface. */
export const WIZPAY_TESTNET_LEGACY_ABI = [
  WIZPAY_BATCH_PAYMENT_ROUTED_EVENT,
  WIZPAY_DIRECT_USDC_PAYMENT_EVENT,
  WIZPAY_PAYROLL_REFERENCE_CONSUMED_EVENT,
  {
    inputs: [],
    name: "feeBps",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "fxEngine",
    outputs: [
      { internalType: "contract IFXEngine", name: "", type: "address" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
    ],
    name: "getEstimatedOutput",
    outputs: [
      { internalType: "uint256", name: "estimatedAmountOut", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address[]", name: "tokenOuts", type: "address[]" },
      { internalType: "uint256[]", name: "amountsIn", type: "uint256[]" },
    ],
    name: "getBatchEstimatedOutputs",
    outputs: [
      {
        internalType: "uint256[]",
        name: "estimatedAmountsOut",
        type: "uint256[]",
      },
      { internalType: "uint256", name: "totalEstimatedOut", type: "uint256" },
      { internalType: "uint256", name: "totalFees", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address[]", name: "tokenOuts", type: "address[]" },
      { internalType: "address[]", name: "recipients", type: "address[]" },
      { internalType: "uint256[]", name: "amountsIn", type: "uint256[]" },
      { internalType: "uint256[]", name: "minAmountsOut", type: "uint256[]" },
      { internalType: "string", name: "referenceId", type: "string" },
    ],
    name: "batchRouteAndPay",
    outputs: [{ internalType: "uint256", name: "totalOut", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** Legacy generated ABI for WizPayMainnetV2. Kept for history/tests. */
export const WIZPAY_MAINNET_V2_RUNTIME_ABI = WIZPAY_MAINNET_V2_ABI;

/** Arc Mainnet runtime payroll ABI. */
export const WIZPAY_MAINNET_ABI = WIZPAY_PAYROLL_MAINNET_ABI;

export { WIZPAY_PAYROLL_MAINNET_ABI, WIZPAY_SWAP_EXECUTOR_MAINNET_ABI };

/** Network-routed compatibility export; never shares a Mainnet/Testnet ABI. */
export const WIZPAY_ABI =
  process.env.NEXT_PUBLIC_WIZPAY_ARC_NETWORK === "arc-mainnet"
    ? WIZPAY_MAINNET_ABI
    : WIZPAY_TESTNET_LEGACY_ABI;

// ── StableFXAdapter LP Events ──
export const LIQUIDITY_ADDED_EVENT = {
  anonymous: false,
  inputs: [
    { indexed: true, internalType: "address", name: "token", type: "address" },
    {
      indexed: false,
      internalType: "uint256",
      name: "amountIn",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "sharesMinted",
      type: "uint256",
    },
  ],
  name: "LiquidityAdded",
  type: "event",
} as const;

export const LIQUIDITY_REMOVED_EVENT = {
  anonymous: false,
  inputs: [
    { indexed: true, internalType: "address", name: "token", type: "address" },
    {
      indexed: false,
      internalType: "uint256",
      name: "amountOut",
      type: "uint256",
    },
    {
      indexed: false,
      internalType: "uint256",
      name: "sharesBurned",
      type: "uint256",
    },
  ],
  name: "LiquidityRemoved",
  type: "event",
} as const;
