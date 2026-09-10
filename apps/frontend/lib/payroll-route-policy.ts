import type { WalletMode } from "@/lib/wallet-mode";

export const CROSS_TOKEN_DISABLED_MESSAGE =
  "Cross-token payments are unavailable on the selected Arc network.";

export type PayrollRoutePolicy =
  | { kind: "direct"; requiresQuote: false; blockedReason: null }
  | { kind: "app-wallet-xylonet"; requiresQuote: true; blockedReason: null }
  | {
      kind: "external-wallet-xylonet";
      requiresQuote: true;
      blockedReason: null;
    }
  | {
      kind: "cross-token-disabled";
      requiresQuote: false;
      blockedReason: typeof CROSS_TOKEN_DISABLED_MESSAGE;
    };

export function resolvePayrollRoutePolicy(input: {
  walletMode: WalletMode;
  network: "arc-testnet" | "arc-mainnet";
  sourceTokenAddress: string;
  targetTokenAddresses: readonly string[];
  crossTokenEnabled: boolean;
}): PayrollRoutePolicy {
  const source = input.sourceTokenAddress.toLowerCase();
  const hasCrossTokenRecipient = input.targetTokenAddresses.some(
    (targetToken) => targetToken.toLowerCase() !== source,
  );

  if (!hasCrossTokenRecipient) {
    return { kind: "direct", requiresQuote: false, blockedReason: null };
  }
  if (input.network !== "arc-testnet" || !input.crossTokenEnabled) {
    return {
      kind: "cross-token-disabled",
      requiresQuote: false,
      blockedReason: CROSS_TOKEN_DISABLED_MESSAGE,
    };
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
