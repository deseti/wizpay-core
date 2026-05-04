import type { CircleTransferBlockchain } from "@/lib/transfer-service";

export type ExternalBridgeRouteKind =
  | "evm-to-evm"
  | "evm-to-solana"
  | "solana-to-evm"
  | "solana-to-solana";

export function isSolanaBridgeChain(chain: CircleTransferBlockchain) {
  return chain === "SOLANA-DEVNET";
}

export function classifyExternalBridgeRoute(
  sourceChain: CircleTransferBlockchain,
  destinationChain: CircleTransferBlockchain
): ExternalBridgeRouteKind {
  const sourceIsSolana = isSolanaBridgeChain(sourceChain);
  const destinationIsSolana = isSolanaBridgeChain(destinationChain);

  if (!sourceIsSolana && !destinationIsSolana) {
    return "evm-to-evm";
  }

  if (!sourceIsSolana && destinationIsSolana) {
    return "evm-to-solana";
  }

  if (sourceIsSolana && !destinationIsSolana) {
    return "solana-to-evm";
  }

  return "solana-to-solana";
}

export function isExternalCrossChainRoute(routeKind: ExternalBridgeRouteKind) {
  return routeKind === "evm-to-solana" || routeKind === "solana-to-evm";
}

export function getRequiredExternalWalletLabels(
  routeKind: ExternalBridgeRouteKind
) {
  switch (routeKind) {
    case "evm-to-solana":
      return ["EVM wallet", "Solana wallet"] as const;
    case "solana-to-evm":
      return ["Solana wallet", "EVM wallet"] as const;
    case "solana-to-solana":
      return ["Solana wallet"] as const;
    default:
      return ["EVM wallet"] as const;
  }
}
