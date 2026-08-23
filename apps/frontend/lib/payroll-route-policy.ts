import type { WalletMode } from "@/lib/wallet-mode";
import type { TokenSymbol } from "@/lib/wizpay";

export type PayrollRoutePolicy =
  | { kind: "direct"; requiresQuote: false; blockedReason: null }
  | { kind: "app-wallet-xylonet"; requiresQuote: true; blockedReason: null }
  | { kind: "external-wallet-xylonet"; requiresQuote: true; blockedReason: null };

export function resolvePayrollRoutePolicy(input: {
  walletMode: WalletMode;
  sourceToken: TokenSymbol;
  targetTokens: readonly TokenSymbol[];
}): PayrollRoutePolicy {
  const hasCrossTokenRecipient = input.targetTokens.some(
    (targetToken) => targetToken !== input.sourceToken,
  );

  if (!hasCrossTokenRecipient) {
    return { kind: "direct", requiresQuote: false, blockedReason: null };
  }
  if (input.walletMode === "circle") {
    return {
      kind: "app-wallet-xylonet",
      requiresQuote: true,
      blockedReason: null,
    };
  }
  return {
    kind: "external-wallet-xylonet",
    requiresQuote: true,
    blockedReason: null,
  };
}
