export type ArcNetworkKey = "arc-mainnet";

export type ArcNetworkEnvironment = "mainnet";

export type ArcCapabilityName =
  | "send"
  | "sameTokenPayroll"
  | "invoice"
  | "paymentLink"
  | "liquidity"
  | "bridge"
  | "swap"
  | "crossTokenPayroll"
  | "crossTokenInvoice"
  | "nanoAgentApi";

export type ArcCapabilities = Readonly<Record<ArcCapabilityName, boolean>>;
export type ArcCapabilityDependencyState = Readonly<{
  directPayment?: boolean;
  sendDirect?: boolean;
  payrollDirect?: boolean;
  invoiceCreation?: boolean;
  paymentLinkDirect?: boolean;
  bridge: boolean;
  swap: boolean;
  nanoAgentApi: boolean;
}>;

export type ArcOperationResourceReadiness = Readonly<{
  sendDirect: boolean;
  payrollDirect: boolean;
  invoiceCreation: boolean;
  paymentLinkDirect: boolean;
  bridgeDirect: boolean;
  swapDirect: boolean;
  crossToken: boolean;
}>;

export type ArcNetworkDefinition = {
  readonly key: "arc-mainnet";
  readonly name: "Arc Mainnet";
  readonly chainId: 5_042;
  readonly environment: "mainnet";
  readonly nativeCurrency: Readonly<{
    name: "USDC";
    symbol: "USDC";
    decimals: 18;
  }>;
  readonly testnet: false;
};

export type UnsupportedArcNetworkCode =
  | "UNSUPPORTED_ARC_NETWORK_KEY"
  | "UNSUPPORTED_ARC_CHAIN_ID";

export type ArcUnavailableReason =
  | "OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE"
  | "OFFICIAL_ARC_MAINNET_EXPLORER_UNAVAILABLE"
  | "WIZPAY_MAINNET_CONTRACT_NOT_DEPLOYED"
  | "UNISWAP_USDC_EURC_POOL_NOT_VERIFIED"
  | "UNISWAP_USDC_EURC_POOL_KEY_NOT_VERIFIED"
  | "UNISWAP_USDC_EURC_POOL_ID_NOT_VERIFIED"
  | "UNISWAP_USDC_EURC_POOL_UNIQUENESS_NOT_VERIFIED"
  | "UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED"
  | "ARC_MAINNET_RPC_QUORUM_UNAVAILABLE"
  | "ARC_MAINNET_UNISWAP_RESOURCE_EVIDENCE_UNAVAILABLE"
  | "ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE"
  | "WIZPAY_MAINNET_SWAP_EXECUTOR_NOT_DEPLOYED";

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

export type VerifiedNonExecutableArcResource<T> = {
  readonly status: "verified";
  readonly value: T;
  readonly evidence: string;
  readonly executable: false;
};

export type CandidateArcResource<T> = {
  readonly status: "candidate";
  readonly value: T;
  readonly evidence: string;
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
  | CandidateArcResource<T>
  | VerifiedNonExecutableArcResource<T>
  | UnavailableArcResource;

export type ArcTokenSymbol = "USDC" | "EURC";

export type ArcTokenResourceValue = {
  readonly symbol: ArcTokenSymbol;
  readonly address: `0x${string}`;
  readonly decimals: 6;
  readonly authoritativeSource?: string;
};

export type ArcWizPayContractKey =
  | "wizpay"
  | "wizpay-swap-executor-v2"
  | "wizpay-swap-executor-mainnet";

export type ArcWizPayContractValue = {
  readonly contract:
    | "WizPay"
    | "WizPayMainnetV2"
    | "WizPayPayrollMainnet"
    | "WizPaySwapExecutorV2"
    | "WizPaySwapExecutorMainnet";
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

export type ArcUniversalRouterContractKey = "universalRouter" | "permit2";

export type ArcProtocolContractKey =
  | ArcUniswapV3ContractKey
  | ArcUniswapV4ContractKey
  | ArcUniversalRouterContractKey;

export type ArcProtocolContractValue = {
  readonly address: `0x${string}`;
  readonly version?: "2.1.1";
  readonly creationBlock?: 1_950_059;
};

export type ArcProtocolCapability =
  | "usdc-eurc-pool"
  | "usdc-eurc-pool-key"
  | "usdc-eurc-pool-id"
  | "usdc-eurc-pool-uniqueness"
  | "usdc-eurc-liquidity"
  | "rpc-quorum"
  | "official-resource-evidence"
  | "execution-authorization";

export type ArcMainnetUniswapV4Readiness = Readonly<{
  network: "arc-mainnet";
  chainId: 5_042;
  pair: readonly ["USDC", "EURC"];
  walletControl: readonly ["external-wallet"];
  custody: "user-controlled-only";
  protocol: "uniswap-v4";
  deploymentSource: string;
  universalRouterSource: string;
  tokens: Readonly<
    Record<"USDC" | "EURC", ArcResource<ArcTokenResourceValue>>
  >;
  contracts: Readonly<
    Record<
      "poolManager" | "stateView" | "quoter" | "universalRouter" | "permit2",
      PublishedArcResource<ArcProtocolContractValue>
    >
  >;
  poolKey: CandidateArcResource<
    Readonly<{
      currency0: "0x3600000000000000000000000000000000000000";
      currency1: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
      fee: 500;
      tickSpacing: 10;
      hooks: "0x0000000000000000000000000000000000000000";
    }>
  >;
  poolId: CandidateArcResource<"0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae">;
  poolUniqueness: UnavailableArcResource<"UNISWAP_USDC_EURC_POOL_UNIQUENESS_NOT_VERIFIED">;
  liquidity: UnavailableArcResource<"UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED">;
  rpcQuorum: UnavailableArcResource<"ARC_MAINNET_RPC_QUORUM_UNAVAILABLE">;
  officialResourceEvidence: VerifiedNonExecutableArcResource<
    Readonly<{
      usdcToEurcTransaction: string;
      eurcToUsdcTransaction: string;
    }>
  >;
  executionAuthorization: UnavailableArcResource<"ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE">;
  capabilityEnabled: false;
  executable: false;
  blockers: readonly ArcUnavailableReason[];
}>;

export declare class ArcNetworkInvariantError extends Error {
  readonly name: "ArcNetworkInvariantError";
  readonly code: "ARC_NETWORK_INVARIANT_VIOLATION";
  constructor(message: string);
}

export declare class ArcCapabilityConfigurationError extends Error {
  readonly name: "ArcCapabilityConfigurationError";
  readonly code:
    | "UNKNOWN_CAPABILITY"
    | "UNKNOWN_CAPABILITY_CONFIGURATION"
    | "INVALID_CAPABILITY_CONFIGURATION"
    | "CONTRADICTORY_CAPABILITY_CONFIGURATION"
    | "CAPABILITY_FORBIDDEN_FOR_NETWORK"
    | "CAPABILITY_RESOURCE_DEPENDENCY_UNAVAILABLE";
  readonly capability?: ArcCapabilityName;
  constructor(code: string, message: string, capability?: ArcCapabilityName);
}

export declare const ARC_CAPABILITY_NAMES: readonly ArcCapabilityName[];
export declare const ARC_CAPABILITY_DEFINITIONS: Readonly<
  Record<ArcNetworkKey, ArcCapabilities>
>;
export declare const ARC_MAINNET_CAPABILITY_ENV_KEYS: Readonly<
  Record<ArcCapabilityName, string>
>;
export declare const ARC_MAINNET_UNISWAP_V4_PUBLICATION: Readonly<{
  network: "arc-mainnet";
  chainId: 5_042;
  pair: readonly ["USDC", "EURC"];
  walletControl: readonly ["external-wallet"];
  custody: "user-controlled-only";
  protocol: "uniswap-v4";
  deploymentSource: string;
  universalRouterSource: string;
}>;

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

export declare const ARC_NETWORK_DEFINITIONS: readonly [ArcNetworkDefinition];

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

export type ArcCctpContractKey =
  | "tokenMessengerV2"
  | "messageTransmitterV2"
  | "irisApi";

export type ArcCctpContractValue = {
  readonly address?: `0x${string}`;
  readonly baseUrl?: string;
  readonly domain?: 26;
  readonly version?: "CCTP_V2" | "v2";
  readonly authoritativeSource?: string;
};

export declare const ARC_CCTP_RESOURCES: Readonly<
  Record<
    ArcNetworkKey,
    Readonly<Record<ArcCctpContractKey, ArcResource<ArcCctpContractValue>>>
  >
>;

export declare function getArcCctpResource(
  networkKey: ArcNetworkKey,
  contractKey: ArcCctpContractKey,
): ArcResource<ArcCctpContractValue>;

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
export declare function parseArcCapabilityName(
  value: unknown,
): ArcCapabilityName;
export declare function resolveArcCapabilities(
  networkKey: ArcNetworkKey,
  environment?: Record<string, string | undefined>,
): ArcCapabilities;
export declare function isArcCapabilityEnabled(
  capabilities: ArcCapabilities,
  capability: unknown,
): boolean;
export declare function getArcOperationResourceReadiness(
  networkKey: ArcNetworkKey,
): ArcOperationResourceReadiness;
export declare function validateArcCapabilityDependencies(
  capabilities: ArcCapabilities,
  resources: ArcCapabilityDependencyState,
): true;

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
): ArcResource<unknown>;

export declare function getArcMainnetUniswapV4Readiness(): ArcMainnetUniswapV4Readiness;

export declare function requireAvailableArcResource<T>(
  resource: ArcResource<T>,
): T;
