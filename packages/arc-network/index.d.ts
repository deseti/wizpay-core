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

export type ArcUnavailableReason =
  | "OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE"
  | "OFFICIAL_ARC_MAINNET_EXPLORER_UNAVAILABLE"
  | "CIRCLE_ARC_MAINNET_USDC_NOT_YET_CONFIRMED"
  | "CIRCLE_ARC_MAINNET_EURC_NOT_YET_CONFIRMED"
  | "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED"
  | "EXTERNAL_PROTOCOL_CONTRACT_NOT_RECORDED_FOR_ARC_TESTNET"
  | "UNISWAP_USDC_EURC_POOL_NOT_VERIFIED"
  | "UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED";

export type AvailableArcResource<T> = {
  readonly status: "available";
  readonly value: T;
};

export type PublishedArcResource<T> = {
  readonly status: "published";
  readonly value: T;
  readonly verification: "onchain-pending";
  readonly executable: false;
};

export type UnavailableArcResource<
  R extends ArcUnavailableReason = ArcUnavailableReason,
> = {
  readonly status: "unavailable";
  readonly reason: R;
};

export type ArcResource<T> =
  | AvailableArcResource<T>
  | PublishedArcResource<T>
  | UnavailableArcResource;

export type ArcTokenSymbol = "USDC" | "EURC";

export type ArcTokenResourceValue = {
  readonly symbol: ArcTokenSymbol;
  readonly address: `0x${string}`;
  readonly decimals: 6;
};

export type ArcWizPayContractKey = "wizpay" | "wizpay-swap-executor-v2";

export type ArcWizPayContractValue = {
  readonly contract: "WizPay" | "WizPaySwapExecutorV2";
  readonly address: `0x${string}`;
  readonly deploymentSource: string;
};

export type ArcProtocol = "uniswap-v3" | "uniswap-v4" | "universal-router";

export type ArcUniswapV3ContractKey =
  | "v3CoreFactory"
  | "multicall"
  | "quoter"
  | "nonfungiblePositionManager"
  | "tickLens"
  | "swapRouter02";

export type ArcUniswapV4ContractKey =
  | "poolManager"
  | "positionManager"
  | "stateView"
  | "quoter";

export type ArcUniversalRouterContractKey = "universalRouter";

export type ArcProtocolContractKey =
  | ArcUniswapV3ContractKey
  | ArcUniswapV4ContractKey
  | ArcUniversalRouterContractKey;

export type ArcProtocolContractValue = {
  readonly address: `0x${string}`;
  readonly version?: "2.1.1";
  readonly creationBlock?: 1_950_059;
};

export type ArcProtocolCapability = "usdc-eurc-pool" | "usdc-eurc-liquidity";

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

export declare class UnknownArcResourceError extends Error {
  readonly name: "UnknownArcResourceError";
  readonly code: "UNKNOWN_ARC_RESOURCE";
  readonly resourceType: string;
  constructor(resourceType: string, key: unknown);
}

export declare class UnavailableArcResourceError extends Error {
  readonly name: "UnavailableArcResourceError";
  readonly code: "ARC_RESOURCE_NOT_AVAILABLE";
  readonly resourceStatus: "published" | "unavailable";
  readonly reason:
    | ArcUnavailableReason
    | "PUBLISHED_RESOURCE_ONCHAIN_VERIFICATION_PENDING";
  constructor(
    resource:
      | PublishedArcResource<unknown>
      | UnavailableArcResource<ArcUnavailableReason>,
  );
}

export declare const ARC_NETWORK_DEFINITIONS: readonly [
  Extract<ArcNetworkDefinition, { readonly key: "arc-testnet" }>,
  Extract<ArcNetworkDefinition, { readonly key: "arc-mainnet" }>,
];

export declare const ARC_RPC_RESOURCES: Readonly<
  Record<ArcNetworkKey, ArcResource<{ readonly url: string }>>
>;

export declare const ARC_EXPLORER_RESOURCES: Readonly<
  Record<ArcNetworkKey, ArcResource<{ readonly baseUrl: string }>>
>;

export declare const ARC_TOKEN_RESOURCES: Readonly<
  Record<
    ArcNetworkKey,
    Readonly<Record<ArcTokenSymbol, ArcResource<ArcTokenResourceValue>>>
  >
>;

export declare const ARC_WIZPAY_CONTRACT_RESOURCES: Readonly<
  Record<
    ArcNetworkKey,
    Readonly<Record<ArcWizPayContractKey, ArcResource<ArcWizPayContractValue>>>
  >
>;

export declare const ARC_PROTOCOL_CONTRACT_RESOURCES: Readonly<
  Record<
    ArcNetworkKey,
    Readonly<
      Partial<
        Record<
          ArcProtocol,
          Readonly<
            Partial<
              Record<
                ArcProtocolContractKey,
                ArcResource<ArcProtocolContractValue>
              >
            >
          >
        >
      >
    >
  >
>;

export declare const ARC_PROTOCOL_CAPABILITY_RESOURCES: Readonly<
  Record<
    ArcNetworkKey,
    Readonly<
      Partial<
        Record<
          "uniswap",
          Readonly<
            Partial<Record<ArcProtocolCapability, UnavailableArcResource>>
          >
        >
      >
    >
  >
>;

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

export declare function getArcRpcResource(
  networkKey: ArcNetworkKey,
): ArcResource<{ readonly url: string }>;

export declare function getArcExplorerResource(
  networkKey: ArcNetworkKey,
): ArcResource<{ readonly baseUrl: string }>;

export declare function getArcTokenResource(
  networkKey: ArcNetworkKey,
  tokenSymbol: ArcTokenSymbol,
): ArcResource<ArcTokenResourceValue>;

export declare function getArcWizPayContractResource(
  networkKey: ArcNetworkKey,
  contractKey: ArcWizPayContractKey,
): ArcResource<ArcWizPayContractValue>;

export declare function getArcProtocolContractResource(
  networkKey: ArcNetworkKey,
  protocol: "uniswap-v3",
  contractKey: ArcUniswapV3ContractKey,
): ArcResource<ArcProtocolContractValue>;
export declare function getArcProtocolContractResource(
  networkKey: ArcNetworkKey,
  protocol: "uniswap-v4",
  contractKey: ArcUniswapV4ContractKey,
): ArcResource<ArcProtocolContractValue>;
export declare function getArcProtocolContractResource(
  networkKey: ArcNetworkKey,
  protocol: "universal-router",
  contractKey: ArcUniversalRouterContractKey,
): ArcResource<ArcProtocolContractValue>;

export declare function getArcProtocolCapabilityResource(
  networkKey: ArcNetworkKey,
  protocol: "uniswap",
  capabilityKey: ArcProtocolCapability,
): UnavailableArcResource;

export declare function requireAvailableArcResource<T>(
  resource: ArcResource<T>,
): T;
