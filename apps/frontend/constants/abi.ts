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

/** Legacy generated ABI for WizPayMainnetV2. Kept for history/tests. */
export const WIZPAY_MAINNET_V2_RUNTIME_ABI = WIZPAY_MAINNET_V2_ABI;

/** Arc Mainnet runtime payroll ABI. */
export const WIZPAY_MAINNET_ABI = WIZPAY_PAYROLL_MAINNET_ABI;

export { WIZPAY_PAYROLL_MAINNET_ABI, WIZPAY_SWAP_EXECUTOR_MAINNET_ABI };

/** Arc Mainnet-only payroll ABI. */
export const WIZPAY_ABI = WIZPAY_MAINNET_ABI;

// ── Liquidity Events (retired) ──
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
