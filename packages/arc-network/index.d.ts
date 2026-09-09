export type ArcNetworkKey = "arc-testnet" | "arc-mainnet";

export type ArcNetworkEnvironment = "testnet" | "mainnet";

export type ArcNetworkDefinition =
  | {
      readonly key: "arc-testnet";
      readonly chainId: 5_042_002;
      readonly environment: "testnet";
    }
  | {
      readonly key: "arc-mainnet";
      readonly chainId: 5_042;
      readonly environment: "mainnet";
    };

export type UnsupportedArcNetworkCode =
  | "UNSUPPORTED_ARC_NETWORK_KEY"
  | "UNSUPPORTED_ARC_CHAIN_ID";

export declare class ArcNetworkInvariantError extends Error {
  readonly name: "ArcNetworkInvariantError";
  readonly code: "ARC_NETWORK_INVARIANT_VIOLATION";
  constructor(message: string);
}

export declare class UnsupportedArcNetworkError extends Error {
  readonly name: "UnsupportedArcNetworkError";
  readonly code: UnsupportedArcNetworkCode;
  constructor(code: UnsupportedArcNetworkCode, value: unknown);
}

export declare const ARC_NETWORK_DEFINITIONS: readonly [
  Extract<ArcNetworkDefinition, { readonly key: "arc-testnet" }>,
  Extract<ArcNetworkDefinition, { readonly key: "arc-mainnet" }>,
];

export declare function assertValidArcNetworkDefinitions(
  entries: readonly unknown[],
): true;

export declare function parseArcNetworkKey(value: unknown): ArcNetworkKey;

export declare function getArcNetworkByKey(
  value: unknown,
): ArcNetworkDefinition;

export declare function getArcNetworkByChainId(
  value: unknown,
): ArcNetworkDefinition;
