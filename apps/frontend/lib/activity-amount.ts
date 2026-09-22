import { formatUnits } from "viem";
import { TOKEN_BY_ADDRESS } from "@/constants/erc20";
import type { UnifiedHistoryItem } from "@/lib/types";
import { SUPPORTED_TOKENS, type TokenSymbol } from "@/lib/wizpay";

const KNOWN_SYMBOLS = ["USDC", "EURC"] as const satisfies readonly TokenSymbol[];

function isKnownSymbol(value: string): value is TokenSymbol {
  return (KNOWN_SYMBOLS as readonly string[]).includes(value);
}

/** Arc Mainnet USDC/EURC decimals from the app token config, never from the activity payload. */
export function arcTokenDecimals(symbol: string): number | undefined {
  if (!isKnownSymbol(symbol)) return undefined;
  return SUPPORTED_TOKENS[symbol]?.decimals;
}

export function arcTokenDecimalsByAddress(address?: string): number | undefined {
  if (!address) return undefined;
  const token = TOKEN_BY_ADDRESS.get(address.toLowerCase());
  if (!token || !isKnownSymbol(token.symbol)) return undefined;
  return token.decimals;
}

/**
 * Format an integer base-unit amount without converting through Number.
 * Trailing fractional zeros are removed: 1000000 USDC base units -> "1".
 */
export function formatActivityBaseUnits(
  raw: string | bigint,
  decimals: number,
): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const formatted = formatUnits(value, decimals);
  if (!formatted.includes(".")) return formatted;
  const trimmed = formatted.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return trimmed.length > 0 ? trimmed : "0";
}

function integerUnits(value: string | undefined): string | undefined {
  return value && /^\d+$/.test(value) ? value : undefined;
}

function knownTotals(totals: Record<string, string> | undefined) {
  if (!totals) return [];
  const entries = Object.entries(totals);
  if (entries.length === 0) return [];
  const parsed = [];
  for (const [symbol, amount] of entries) {
    const units = integerUnits(amount);
    const decimals = arcTokenDecimals(symbol);
    if (!units || decimals === undefined) return [];
    parsed.push({ symbol, units, decimals });
  }
  return parsed;
}

/** One display string for a Recent Activity amount. Raw base units stay unchanged upstream. */
export function presentActivityAmount(item: UnifiedHistoryItem): string {
  const totals = knownTotals(item.tokenTotals);
  if (totals.length > 1) {
    return totals
      .map(
        (total) =>
          `${formatActivityBaseUnits(total.units, total.decimals)} ${total.symbol}`,
      )
      .join(" · ");
  }
  if (totals.length === 1) {
    const total = totals[0];
    return `${formatActivityBaseUnits(total.units, total.decimals)} ${total.symbol}`;
  }

  const raw =
    integerUnits(item.amountDisplay) ??
    (item.totalAmountIn !== undefined ? item.totalAmountIn.toString() : undefined);
  const symbolFromAddress = item.tokenIn
    ? TOKEN_BY_ADDRESS.get(item.tokenIn.toLowerCase())?.symbol
    : undefined;
  const symbol =
    item.tokenSymbol && isKnownSymbol(item.tokenSymbol)
      ? item.tokenSymbol
      : symbolFromAddress && isKnownSymbol(symbolFromAddress)
        ? symbolFromAddress
        : undefined;
  const decimals = symbol
    ? arcTokenDecimals(symbol)
    : arcTokenDecimalsByAddress(item.tokenIn);
  if (!raw || !symbol || decimals === undefined) return "—";
  return `${formatActivityBaseUnits(raw, decimals)} ${symbol}`;
}
