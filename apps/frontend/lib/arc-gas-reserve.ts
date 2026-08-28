import { parseUnits } from "viem";

export const ARC_USDC_DECIMALS = 6;
export const ARC_NATIVE_USDC_DECIMALS = 18;
export const ARC_GAS_FALLBACK_UNITS = 100_000n;
export const ARC_GAS_SAFETY_MARGIN_UNITS = 5_000n;
export const ARC_GAS_SAFETY_BPS = 2_000n;

type FeeLevel = { gasLimit?: unknown; maxFee?: unknown; gasPrice?: unknown; l1Fee?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function decimalUnits(value: unknown, decimals: number) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  try {
    return parseUnits(value, decimals);
  } catch {
    return null;
  }
}

function ceilDiv(value: bigint, divisor: bigint) {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

/** Parses Circle's documented EIP-1559 fee-level response into native USDC wei. */
export function readCircleFeeEstimateWei(payload: unknown): bigint | null {
  const root = record(payload);
  const data = record(root?.data) ?? root;
  const level = (record(data?.medium) ?? record(data?.high) ?? record(data?.low)) as FeeLevel | null;
  if (!level) return null;
  const gasLimit = positiveInteger(level.gasLimit);
  const price = decimalUnits(level.maxFee ?? level.gasPrice, 9);
  if (!gasLimit || !price) return null;
  const l1Fee = decimalUnits(level.l1Fee, ARC_NATIVE_USDC_DECIMALS) ?? 0n;
  return gasLimit * price + l1Fee;
}

export function gasReserveFromFeeWei(feeWei: bigint | null) {
  if (feeWei === null || feeWei < 0n) {
    return { reserveUnits: ARC_GAS_FALLBACK_UNITS, source: "fallback" as const };
  }
  const estimatedUnits = ceilDiv(
    feeWei,
    10n ** BigInt(ARC_NATIVE_USDC_DECIMALS - ARC_USDC_DECIMALS),
  );
  const variableMargin = ceilDiv(estimatedUnits * ARC_GAS_SAFETY_BPS, 10_000n);
  return {
    reserveUnits: estimatedUnits + variableMargin + ARC_GAS_SAFETY_MARGIN_UNITS,
    source: "estimate" as const,
  };
}

export function sumGasReserves(feesWei: Array<bigint | null>) {
  if (feesWei.some((fee) => fee === null || fee < 0n)) {
    return { reserveUnits: ARC_GAS_FALLBACK_UNITS, source: "fallback" as const };
  }
  let total = 0n;
  for (const fee of feesWei) total += fee ?? 0n;
  return gasReserveFromFeeWei(total);
}

export function calculateArcMaxAmount(input: {
  inputBalance: bigint;
  nativeUsdcBalance: bigint;
  reserveUnits: bigint;
  tokenIsUsdc: boolean;
}) {
  const { inputBalance, nativeUsdcBalance, reserveUnits, tokenIsUsdc } = input;
  if (reserveUnits < 0n || inputBalance <= 0n) return 0n;
  if (tokenIsUsdc) return inputBalance > reserveUnits ? inputBalance - reserveUnits : 0n;
  return nativeUsdcBalance >= reserveUnits ? inputBalance : 0n;
}

export function hasArcGasForAmount(input: {
  amountUnits: bigint;
  inputBalance: bigint;
  nativeUsdcBalance: bigint;
  reserveUnits: bigint;
  tokenIsUsdc: boolean;
}) {
  if (input.amountUnits <= 0n || input.amountUnits > input.inputBalance) return false;
  return input.tokenIsUsdc
    ? input.amountUnits + input.reserveUnits <= input.nativeUsdcBalance
    : input.nativeUsdcBalance >= input.reserveUnits;
}
