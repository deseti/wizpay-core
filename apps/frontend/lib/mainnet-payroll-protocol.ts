import {
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_USDC,
  ARC_MAINNET_USDC_NATIVE_SCALE,
  applySlippage,
  calculateMinHopPriceX36,
} from "@/lib/mainnet-uniswap-v4-protocol";

export const WIZPAY_PAYROLL_MAINNET_ADDRESS =
  "0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34" as const;
export const ARC_MAINNET_CHAIN_ID = 5_042 as const;

const PAYROLL_ABI = parseAbi([
  "function executeSameTokenPayroll(address token, address[] recipients, uint256[] amounts, string referenceId) returns (uint256 totalOut)",
  "function executeCrossTokenPayroll(address tokenIn, address tokenOut, address[] recipients, uint256[] outputAmounts, uint256 grossInput, uint256 minTotalOut, uint256 minHopPriceX36, uint256 deadline, string referenceId) payable returns (uint256 amountOut)",
]);
const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type MainnetPayrollGroupKind = "same-token" | "cross-token";

export type MainnetPayrollRecipient = Readonly<{
  address: Address;
  amount: bigint;
  tokenOut: Address;
}>;

export type MainnetPayrollGroup = Readonly<{
  kind: MainnetPayrollGroupKind;
  tokenIn: Address;
  tokenOut: Address;
  recipients: readonly Address[];
  amounts: readonly bigint[];
  referenceId: string;
}>;

export function sameTokenFunding(amounts: readonly bigint[], feeBps: bigint) {
  return amounts.reduce((sum, amount) => {
    if (amount <= 0n) throw new Error("Payroll amounts must be positive.");
    return sum + amount + (amount * feeBps) / 10_000n;
  }, 0n);
}

export function nativePayrollValue(tokenIn: Address, amount: bigint) {
  if (amount <= 0n) throw new Error("Payroll input must be positive.");
  return isAddressEqual(tokenIn, ARC_MAINNET_UNISWAP_V4_USDC)
    ? amount * ARC_MAINNET_USDC_NATIVE_SCALE
    : 0n;
}

export function splitHomogeneousPayrollGroups(input: {
  tokenIn: Address;
  referenceId: string;
  recipients: readonly MainnetPayrollRecipient[];
}): readonly MainnetPayrollGroup[] {
  if (input.recipients.length === 0) {
    throw new Error("Payroll requires at least one recipient.");
  }
  const grouped = new Map<string, MainnetPayrollRecipient[]>();
  for (const recipient of input.recipients) {
    const key = recipient.tokenOut.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(recipient);
    grouped.set(key, list);
  }
  const tokenIn = input.tokenIn.toLowerCase();
  const ordered = [...grouped.entries()].sort(([left], [right]) =>
    left === tokenIn ? -1 : right === tokenIn ? 1 : left.localeCompare(right),
  );
  const multiple = ordered.length > 1;
  return Object.freeze(
    ordered.map(([tokenOut, rows]) =>
      Object.freeze({
        kind: tokenOut === tokenIn ? "same-token" : "cross-token",
        tokenIn: input.tokenIn,
        tokenOut: rows[0].tokenOut,
        recipients: Object.freeze(rows.map((row) => row.address)),
        amounts: Object.freeze(rows.map((row) => row.amount)),
        referenceId: multiple
          ? `${input.referenceId}:${tokenOut.slice(0, 10)}`
          : input.referenceId,
      }),
    ),
  );
}

export function encodeSameTokenPayroll(input: {
  token: Address;
  recipients: readonly Address[];
  amounts: readonly bigint[];
  referenceId: string;
}): Hex {
  if (input.recipients.length !== input.amounts.length) {
    throw new Error("Payroll recipients and amounts must match.");
  }
  return encodeFunctionData({
    abi: PAYROLL_ABI,
    functionName: "executeSameTokenPayroll",
    args: [input.token, [...input.recipients], [...input.amounts], input.referenceId],
  });
}

export function encodeCrossTokenPayroll(input: {
  tokenIn: Address;
  tokenOut: Address;
  recipients: readonly Address[];
  outputAmounts: readonly bigint[];
  grossInput: bigint;
  minTotalOut: bigint;
  minHopPriceX36: bigint;
  deadline: number;
  referenceId: string;
}): Hex {
  if (isAddressEqual(input.tokenIn, input.tokenOut)) {
    throw new Error("Cross-token payroll requires distinct tokens.");
  }
  if (
    !(
      (isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
        isAddressEqual(input.tokenOut, ARC_MAINNET_UNISWAP_V4_EURC)) ||
      (isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_EURC) &&
        isAddressEqual(input.tokenOut, ARC_MAINNET_UNISWAP_V4_USDC))
    )
  ) {
    throw new Error("Only the Arc Mainnet USDC/EURC pair is supported.");
  }
  return encodeFunctionData({
    abi: PAYROLL_ABI,
    functionName: "executeCrossTokenPayroll",
    args: [
      input.tokenIn,
      input.tokenOut,
      [...input.recipients],
      [...input.outputAmounts],
      input.grossInput,
      input.minTotalOut,
      input.minHopPriceX36,
      BigInt(input.deadline),
      input.referenceId,
    ],
  });
}

export function payrollApprovalTarget(input: {
  tokenIn: Address;
  tokenOut: Address;
  funding: bigint;
}): Readonly<{ token: Address; spender: Address; amount: bigint }> | null {
  if (isAddressEqual(input.tokenIn, ARC_MAINNET_UNISWAP_V4_USDC) &&
    !isAddressEqual(input.tokenIn, input.tokenOut)) {
    return null;
  }
  return Object.freeze({
    token: input.tokenIn,
    spender: WIZPAY_PAYROLL_MAINNET_ADDRESS,
    amount: input.funding,
  });
}

export function encodePayrollApproval(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, amount],
  });
}

export function crossTokenQuoteBounds(input: {
  amountIn: bigint;
  amountOut: bigint;
  slippageBps: number;
}) {
  const minTotalOut = applySlippage(input.amountOut, input.slippageBps);
  return Object.freeze({
    minTotalOut,
    minHopPriceX36: calculateMinHopPriceX36(
      input.amountIn,
      input.amountOut,
      input.slippageBps,
    ),
  });
}
