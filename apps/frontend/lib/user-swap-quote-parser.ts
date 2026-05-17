import { formatUnits } from "viem";

import {
  parseAmountToUnits,
  SUPPORTED_TOKENS,
  type TokenSymbol,
} from "@/lib/wizpay";

export const EXPECTED_OUTPUT_FALLBACK_PATHS = [
  "quote.estimatedAmount",
  "quote.route.steps.0.estimate.toAmount",
  "estimatedOutput",
  "amountOut",
] as const;

export const MINIMUM_OUTPUT_FALLBACK_PATHS = [
  "quote.minAmount",
  "minimumOutput",
  "minOutput",
] as const;

type SwapQuoteLike = {
  expectedOutput?: unknown;
  minimumOutput?: unknown;
  raw?: unknown;
  rawQuote?: unknown;
};

export type ParsedUserSwapQuoteAmount = {
  displayAmount: string;
  displayWithToken: string;
  rawAmount: string;
  units: bigint;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) {
      return current[Number(key)];
    }

    if (!isRecord(current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

export function findFirst(
  value: unknown,
  paths: readonly string[],
): unknown {
  for (const path of paths) {
    const found = getPath(value, path);

    if (found !== undefined && found !== null) {
      return found;
    }
  }

  return undefined;
}

export function findFirstString(value: unknown, paths: readonly string[]) {
  const found = findFirst(value, paths);

  return typeof found === "string" && found.trim() ? found.trim() : null;
}

export function stringifyAmount(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (isRecord(value)) {
    return stringifyAmount(value.amount ?? value.value ?? value.toAmount);
  }

  return null;
}

function getRawQuote(quote: SwapQuoteLike) {
  return "raw" in quote ? quote.raw : quote.rawQuote;
}

export function getUserSwapExpectedOutputValue(quote: SwapQuoteLike) {
  return (
    quote.expectedOutput ??
    findFirst(getRawQuote(quote), EXPECTED_OUTPUT_FALLBACK_PATHS)
  );
}

export function getUserSwapMinimumOutputValue(quote: SwapQuoteLike) {
  return (
    quote.minimumOutput ??
    findFirst(getRawQuote(quote), MINIMUM_OUTPUT_FALLBACK_PATHS)
  );
}

export function parseUserSwapQuoteAmount(
  value: unknown,
  token: TokenSymbol,
): ParsedUserSwapQuoteAmount | null {
  const rawAmount = stringifyAmount(value);

  if (!rawAmount) {
    return null;
  }

  try {
    const units = BigInt(rawAmount);
    const displayAmount = formatUnits(units, SUPPORTED_TOKENS[token].decimals);

    return {
      displayAmount,
      displayWithToken: `${displayAmount} ${token}`,
      rawAmount,
      units,
    };
  } catch {
    try {
      const units = parseAmountToUnits(
        rawAmount,
        SUPPORTED_TOKENS[token].decimals,
      );

      return {
        displayAmount: rawAmount,
        displayWithToken: `${rawAmount} ${token}`,
        rawAmount,
        units,
      };
    } catch {
      return null;
    }
  }
}

export function formatUserSwapQuoteAmount(
  value: unknown,
  token: TokenSymbol,
): string | null {
  const parsed = parseUserSwapQuoteAmount(value, token);

  if (parsed) {
    return parsed.displayWithToken;
  }

  const rawAmount = stringifyAmount(value);
  return rawAmount ? `${rawAmount} ${token}` : null;
}

export function getUserSwapExpectedOutputDisplay(
  quote: SwapQuoteLike | null,
  tokenOut: TokenSymbol,
) {
  return quote
    ? formatUserSwapQuoteAmount(getUserSwapExpectedOutputValue(quote), tokenOut)
    : null;
}

export function getUserSwapMinimumOutputDisplay(
  quote: SwapQuoteLike | null,
  tokenOut: TokenSymbol,
) {
  return quote
    ? formatUserSwapQuoteAmount(getUserSwapMinimumOutputValue(quote), tokenOut)
    : null;
}
