import { formatUnits, parseUnits } from "viem";

export const BRIDGE_USDC_DECIMALS = 6;
export const DEFAULT_BRIDGE_AMOUNT = "1";

export type BridgeAmountValidation = {
  amountUnits: bigint | null;
  error: string | null;
};

export function parseBridgeAmount(value: string): BridgeAmountValidation {
  const input = value.trim();
  if (!input) return { amountUnits: null, error: "Enter a USDC amount." };
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) {
    return { amountUnits: null, error: "Enter a valid decimal USDC amount." };
  }
  const fraction = input.split(".")[1] ?? "";
  if (fraction.length > BRIDGE_USDC_DECIMALS) {
    return {
      amountUnits: null,
      error: `USDC supports up to ${BRIDGE_USDC_DECIMALS} decimal places.`,
    };
  }

  try {
    const amountUnits = parseUnits(input, BRIDGE_USDC_DECIMALS);
    if (amountUnits <= 0n) {
      return { amountUnits: null, error: "Amount must be greater than zero." };
    }
    if (
      parseUnits(
        formatUnits(amountUnits, BRIDGE_USDC_DECIMALS),
        BRIDGE_USDC_DECIMALS,
      ) !== amountUnits
    ) {
      return {
        amountUnits: null,
        error: "Amount and base units are inconsistent.",
      };
    }
    return { amountUnits, error: null };
  } catch {
    return { amountUnits: null, error: "Enter a valid decimal USDC amount." };
  }
}

export function isBridgeAmountLocked(input: {
  busy: boolean;
  approvalConfirmed: boolean;
  sourceBurnConfirmed: boolean;
}) {
  return input.busy || input.approvalConfirmed || input.sourceBurnConfirmed;
}
