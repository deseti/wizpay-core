export const CROSS_TOKEN_DISABLED_MESSAGE =
  "Cross-token payments are unavailable on Arc Mainnet.";

export type PayrollRoutePolicy =
  | { kind: "direct"; requiresQuote: false; blockedReason: null }
  | {
      kind: "external-wallet-mainnet-atomic";
      requiresQuote: true;
      blockedReason: null;
    }
  | {
      kind: "cross-token-disabled";
      requiresQuote: false;
      blockedReason: typeof CROSS_TOKEN_DISABLED_MESSAGE;
    };

export function resolvePayrollRoutePolicy(input: {
  network: "arc-mainnet";
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
  if (!input.crossTokenEnabled) {
    return {
      kind: "cross-token-disabled",
      requiresQuote: false,
      blockedReason: CROSS_TOKEN_DISABLED_MESSAGE,
    };
  }
  return {
    kind: "external-wallet-mainnet-atomic",
    requiresQuote: true,
    blockedReason: null,
  };
}
