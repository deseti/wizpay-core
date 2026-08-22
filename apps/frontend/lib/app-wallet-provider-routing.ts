import type { TokenSymbol } from "@/lib/wizpay";

export const APP_WALLET_ROUTING_THRESHOLD_BASE_UNITS = 10_000_000n;

export type RoutedAppWalletProvider = "xylonet" | "stablefx";

export function resolveAutomaticAppWalletProvider(
  amountInBaseUnits: string,
): RoutedAppWalletProvider | undefined {
  if (!/^\d+$/.test(amountInBaseUnits) || BigInt(amountInBaseUnits) <= 0n) {
    return undefined;
  }

  return BigInt(amountInBaseUnits) < APP_WALLET_ROUTING_THRESHOLD_BASE_UNITS
    ? "xylonet"
    : "stablefx";
}

export function resolveAppWalletPayrollProvider(input: {
  sourceToken: TokenSymbol;
  targetToken: TokenSymbol;
  aggregateAmount: string;
}): RoutedAppWalletProvider | null {
  if (input.sourceToken === input.targetToken) {
    return null;
  }

  return resolveAutomaticAppWalletProvider(input.aggregateAmount) ?? null;
}
