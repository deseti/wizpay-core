import {
  getArcExplorerResource,
  getArcMainnetUniswapV4Readiness,
  getArcNetworkByKey,
  getArcProtocolContractResource,
  getArcRpcResource,
  getArcTokenResource,
  getArcWizPayContractResource,
  parseArcNetworkKey,
  requireAvailableArcResource,
  type ArcNetworkDefinition,
  type ArcNetworkKey,
  type ArcResource,
  type ArcTokenResourceValue,
  type ArcWizPayContractValue,
} from "@wizpay/arc-network";

type RpcValue = { readonly url: string };
type ExplorerValue = { readonly baseUrl: string };

export type FrontendArcNetworkResourceState = Readonly<{
  key: ArcNetworkKey;
  network: ArcNetworkDefinition;
  rpc: ArcResource<RpcValue>;
  explorer: ArcResource<ExplorerValue>;
  tokens: Readonly<{
    USDC: ArcResource<ArcTokenResourceValue>;
    EURC: ArcResource<ArcTokenResourceValue>;
  }>;
  contracts: Readonly<{
    wizpay: ArcResource<ArcWizPayContractValue>;
    wizpaySwapExecutorV2: ArcResource<ArcWizPayContractValue>;
  }>;
  uniswapSwapRouter02: ReturnType<typeof getArcProtocolContractResource>;
  mainnetUniswapV4: ReturnType<typeof getArcMainnetUniswapV4Readiness> | null;
}>;

export type FrontendArcNetworkConfiguration = Readonly<{
  key: ArcNetworkKey;
  name: "Arc Testnet" | "Arc Mainnet";
  chainId: number;
  environment: "testnet" | "mainnet";
  nativeCurrency: Readonly<{ name: "USDC"; symbol: "USDC"; decimals: 18 }>;
  testnet: boolean;
  rpcUrl?: string;
  explorerBaseUrl?: string;
  tokens: Readonly<{
    USDC?: ArcTokenResourceValue;
    EURC?: ArcTokenResourceValue;
  }>;
  contracts: Readonly<{
    wizpay?: ArcWizPayContractValue;
    wizpaySwapExecutorV2?: ArcWizPayContractValue;
  }>;
  transactionalAvailable: boolean;
  unavailableReason?: string;
}>;

export type FrontendArcEnvironment = Record<string, string | undefined>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function resolveFrontendArcNetworkResourceState(
  selector: unknown,
): FrontendArcNetworkResourceState {
  const key = parseArcNetworkKey(selector);
  return deepFreeze({
    key,
    network: getArcNetworkByKey(key),
    rpc: getArcRpcResource(key),
    explorer: getArcExplorerResource(key),
    tokens: {
      USDC: getArcTokenResource(key, "USDC"),
      EURC: getArcTokenResource(key, "EURC"),
    },
    contracts: {
      wizpay: getArcWizPayContractResource(key, "wizpay"),
      wizpaySwapExecutorV2: getArcWizPayContractResource(
        key,
        "wizpay-swap-executor-v2",
      ),
    },
    uniswapSwapRouter02: getArcProtocolContractResource(
      key,
      "uniswap-v3",
      "swapRouter02",
    ),
    mainnetUniswapV4:
      key === "arc-mainnet" ? getArcMainnetUniswapV4Readiness() : null,
  });
}

export function requireFrontendTransactionalArcNetworkConfiguration(
  state: FrontendArcNetworkResourceState,
): FrontendArcNetworkConfiguration {
  const rpc = requireAvailableArcResource(state.rpc);
  const explorer = requireAvailableArcResource(state.explorer);
  const usdc = requireAvailableArcResource(state.tokens.USDC);
  const eurc =
    state.key === "arc-testnet"
      ? requireAvailableArcResource(state.tokens.EURC)
      : undefined;
  const wizpay = requireAvailableArcResource(state.contracts.wizpay);
  const wizpaySwapExecutorV2 =
    state.key === "arc-testnet"
      ? requireAvailableArcResource(state.contracts.wizpaySwapExecutorV2)
      : undefined;

  return deepFreeze({
    key: state.key,
    name: state.network.name,
    chainId: state.network.chainId,
    environment: state.network.environment,
    nativeCurrency: state.network.nativeCurrency,
    testnet: state.network.testnet,
    rpcUrl: rpc.url,
    explorerBaseUrl: explorer.baseUrl,
    tokens: { USDC: usdc, ...(eurc ? { EURC: eurc } : {}) },
    contracts: {
      wizpay,
      ...(wizpaySwapExecutorV2 ? { wizpaySwapExecutorV2 } : {}),
    },
    transactionalAvailable: true,
  });
}

export function createFrontendBuildSafeArcNetworkConfiguration(
  selector: unknown,
): FrontendArcNetworkConfiguration {
  const state = resolveFrontendArcNetworkResourceState(selector);
  try {
    return requireFrontendTransactionalArcNetworkConfiguration(state);
  } catch (error) {
    if (state.key !== "arc-mainnet") throw error;
    return deepFreeze<FrontendArcNetworkConfiguration>({
      key: state.key,
      name: state.network.name,
      chainId: state.network.chainId,
      environment: state.network.environment,
      nativeCurrency: state.network.nativeCurrency,
      testnet: state.network.testnet,
      tokens: {},
      contracts: {},
      transactionalAvailable: false,
      unavailableReason:
        error instanceof Error
          ? error.message
          : "Arc Mainnet execution resources are unavailable.",
    });
  }
}

export function assertFrontendTransactionsAvailable(
  config: FrontendArcNetworkConfiguration,
) {
  if (!config.transactionalAvailable)
    throw new Error(
      config.unavailableReason ??
        "Transactions are unavailable on the selected Arc network.",
    );
  return true;
}

export function createFrontendTransactionalArcNetworkConfiguration(
  selector: unknown,
) {
  return requireFrontendTransactionalArcNetworkConfiguration(
    resolveFrontendArcNetworkResourceState(selector),
  );
}

function assertExactOverride(
  name: string,
  configured: string | undefined,
  expected: string,
  address = false,
) {
  if (configured === undefined || configured === "") return;
  const matches = address
    ? configured.toLowerCase() === expected.toLowerCase()
    : configured === expected;
  if (!matches) throw new Error(`${name} conflicts with WIZPAY_ARC_NETWORK.`);
}

export function validateFrontendArcNetworkOverrides(
  config: FrontendArcNetworkConfiguration,
  environment: FrontendArcEnvironment,
) {
  if (!config.transactionalAvailable) {
    for (const name of [
      "NEXT_PUBLIC_RPC_URL",
      "NEXT_PUBLIC_CONTRACT_ADDRESS",
      "NEXT_PUBLIC_WIZPAY_ADDRESS",
      "NEXT_PUBLIC_ARC_USDC",
      "NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS",
    ]) {
      if (environment[name] !== undefined && environment[name] !== "")
        throw new Error(
          `${name} cannot override unavailable Arc Mainnet resources.`,
        );
    }
    return;
  }
  if (!config.rpcUrl || !config.tokens.USDC || !config.contracts.wizpay) {
    throw new Error("Transactional Arc configuration is incomplete.");
  }
  assertExactOverride(
    "NEXT_PUBLIC_RPC_URL",
    environment.NEXT_PUBLIC_RPC_URL,
    config.rpcUrl,
  );
  for (const name of [
    "NEXT_PUBLIC_CONTRACT_ADDRESS",
    "NEXT_PUBLIC_WIZPAY_ADDRESS",
  ]) {
    assertExactOverride(
      name,
      environment[name],
      config.contracts.wizpay.address,
      true,
    );
  }
  assertExactOverride(
    "NEXT_PUBLIC_ARC_USDC",
    environment.NEXT_PUBLIC_ARC_USDC,
    config.tokens.USDC.address,
    true,
  );
  const swapOverride = environment.NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS;
  if (config.contracts.wizpaySwapExecutorV2) {
    assertExactOverride(
      "NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS",
      swapOverride,
      config.contracts.wizpaySwapExecutorV2.address,
      true,
    );
  } else if (swapOverride !== undefined && swapOverride !== "") {
    throw new Error(
      "NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS is unavailable for the selected network.",
    );
  }
}

export function getExplorerTxUrlForNetwork(
  state: FrontendArcNetworkResourceState,
  hash: string | null | undefined,
  chainId: number | undefined,
) {
  if (
    !/^0x[a-fA-F0-9]{64}$/.test(hash ?? "") ||
    chainId === undefined ||
    chainId !== state.network.chainId ||
    state.explorer.status !== "available"
  ) {
    return null;
  }
  return `${state.explorer.value.baseUrl}/tx/${hash}`;
}
