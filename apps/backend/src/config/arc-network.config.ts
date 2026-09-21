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
  resolveArcCapabilities,
  type ArcNetworkDefinition,
  type ArcNetworkKey,
  type ArcResource,
  type ArcTokenResourceValue,
  type ArcWizPayContractValue,
} from '@wizpay/arc-network';

export const ARC_MAINNET_KEY = 'arc-mainnet' as const;
export const ARC_MAINNET_CHAIN_ID = 5_042 as const;

type RpcValue = { readonly url: string };
type ExplorerValue = { readonly baseUrl: string };

export type BackendArcNetworkResourceState = Readonly<{
  key: typeof ARC_MAINNET_KEY;
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
    wizpaySwapExecutorMainnet: ArcResource<ArcWizPayContractValue>;
  }>;
  uniswapSwapRouter02: ReturnType<typeof getArcProtocolContractResource>;
  mainnetUniswapV4: ReturnType<typeof getArcMainnetUniswapV4Readiness>;
}>;

export type BackendArcNetworkConfiguration = Readonly<{
  key: typeof ARC_MAINNET_KEY;
  chainId: number;
  environment: 'mainnet';
  rpcUrl: string;
  explorerBaseUrl: string;
  tokens: Readonly<{
    USDC: ArcTokenResourceValue;
    EURC?: ArcTokenResourceValue;
  }>;
  contracts: Readonly<{
    wizpay?: ArcWizPayContractValue;
    wizpaySwapExecutorV2?: ArcWizPayContractValue;
    wizpaySwapExecutorMainnet?: ArcWizPayContractValue;
  }>;
}>;

export type ArcNetworkEnvironment = Record<string, string | undefined>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Parse an Arc network selector and fail closed unless it is Arc Mainnet.
 * WizPay backend execution is strict Mainnet-only: any other selector,
 * including retired networks, is rejected instead of routed elsewhere.
 */
export function requireMainnetArcNetworkKey(
  selector: unknown,
): typeof ARC_MAINNET_KEY {
  const key: ArcNetworkKey = parseArcNetworkKey(selector);
  if (key !== ARC_MAINNET_KEY) {
    throw new Error(
      `Unsupported Arc network: ${JSON.stringify(key)}. WizPay backend requires ${ARC_MAINNET_KEY}.`,
    );
  }
  return key;
}

export function resolveBackendArcNetworkResourceState(
  selector: unknown,
): BackendArcNetworkResourceState {
  const key = requireMainnetArcNetworkKey(selector);
  return deepFreeze({
    key,
    network: getArcNetworkByKey(key),
    rpc: getArcRpcResource(key),
    explorer: getArcExplorerResource(key),
    tokens: {
      USDC: getArcTokenResource(key, 'USDC'),
      EURC: getArcTokenResource(key, 'EURC'),
    },
    contracts: {
      wizpay: getArcWizPayContractResource(key, 'wizpay'),
      wizpaySwapExecutorV2: getArcWizPayContractResource(
        key,
        'wizpay-swap-executor-v2',
      ),
      wizpaySwapExecutorMainnet: getArcWizPayContractResource(
        key,
        'wizpay-swap-executor-mainnet',
      ),
    },
    uniswapSwapRouter02: getArcProtocolContractResource(
      key,
      'uniswap-v3',
      'swapRouter02',
    ),
    mainnetUniswapV4: getArcMainnetUniswapV4Readiness(),
  });
}

function assertExactLegacyValue(
  name: string,
  configured: string | undefined,
  expected: string,
) {
  if (
    configured !== undefined &&
    configured !== '' &&
    configured !== expected
  ) {
    throw new Error(`${name} conflicts with WIZPAY_ARC_NETWORK.`);
  }
}

function validateLegacyActiveConfiguration(
  config: BackendArcNetworkConfiguration,
  environment: ArcNetworkEnvironment,
) {
  assertExactLegacyValue('RPC_URL', environment.RPC_URL, config.rpcUrl);
  assertExactLegacyValue('ARC_RPC_URL', environment.ARC_RPC_URL, config.rpcUrl);
  assertExactLegacyValue(
    'NEXT_PUBLIC_RPC_URL',
    environment.NEXT_PUBLIC_RPC_URL,
    config.rpcUrl,
  );
  assertExactLegacyValue(
    'CHAIN_ID',
    environment.CHAIN_ID,
    String(config.chainId),
  );
  assertExactLegacyValue(
    'NEXT_PUBLIC_CONTRACT_ADDRESS',
    environment.NEXT_PUBLIC_CONTRACT_ADDRESS,
    config.contracts.wizpay?.address ?? '',
  );
  assertExactLegacyValue(
    'NEXT_PUBLIC_WIZPAY_ADDRESS',
    environment.NEXT_PUBLIC_WIZPAY_ADDRESS,
    config.contracts.wizpay?.address ?? '',
  );
  assertExactLegacyValue(
    'WIZPAY_SWAP_EXECUTOR_V2_ADDRESS',
    environment.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS,
    config.contracts.wizpaySwapExecutorV2?.address ?? '',
  );
  assertExactLegacyValue(
    'WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS',
    environment.WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
    config.contracts.wizpaySwapExecutorMainnet?.address ?? '',
  );
}

export function requireBackendArcNetworkReadiness(
  state: BackendArcNetworkResourceState,
): BackendArcNetworkConfiguration {
  if (state.key !== ARC_MAINNET_KEY) {
    throw new Error(
      `Unsupported Arc network: ${JSON.stringify(state.key)}. WizPay backend requires ${ARC_MAINNET_KEY}.`,
    );
  }
  if (state.network.chainId !== ARC_MAINNET_CHAIN_ID) {
    throw new Error(
      `Unsupported Arc chain ID: ${String(state.network.chainId)}. WizPay backend requires ${ARC_MAINNET_CHAIN_ID}.`,
    );
  }
  const rpc = requireAvailableArcResource(state.rpc);
  const explorer = requireAvailableArcResource(state.explorer);
  const usdc = requireAvailableArcResource(state.tokens.USDC);
  const eurc = optionalAvailable(state.tokens.EURC);
  const wizpay = optionalAvailable(state.contracts.wizpay);
  const wizpaySwapExecutorV2 = optionalAvailable(
    state.contracts.wizpaySwapExecutorV2,
  );
  const wizpaySwapExecutorMainnet = optionalAvailable(
    state.contracts.wizpaySwapExecutorMainnet,
  );

  return deepFreeze({
    key: state.key,
    chainId: state.network.chainId,
    environment: 'mainnet',
    rpcUrl: rpc.url,
    explorerBaseUrl: explorer.baseUrl,
    tokens: { USDC: usdc, ...(eurc ? { EURC: eurc } : {}) },
    contracts: {
      ...(wizpay ? { wizpay } : {}),
      ...(wizpaySwapExecutorV2 ? { wizpaySwapExecutorV2 } : {}),
      ...(wizpaySwapExecutorMainnet ? { wizpaySwapExecutorMainnet } : {}),
    },
  });
}

function optionalAvailable<T>(resource: ArcResource<T>): T | undefined {
  return resource.status === 'available' ? resource.value : undefined;
}

export function loadBackendArcNetworkConfiguration(
  environment: ArcNetworkEnvironment = process.env,
): BackendArcNetworkConfiguration {
  const key = requireMainnetArcNetworkKey(environment.WIZPAY_ARC_NETWORK);
  resolveArcCapabilities(key, environment);
  const state = resolveBackendArcNetworkResourceState(key);
  const config = requireBackendArcNetworkReadiness(state);
  validateLegacyActiveConfiguration(config, environment);
  return config;
}
