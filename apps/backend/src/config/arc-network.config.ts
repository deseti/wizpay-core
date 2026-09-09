import {
  getArcExplorerResource,
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

type RpcValue = { readonly url: string };
type ExplorerValue = { readonly baseUrl: string };

export type BackendArcNetworkResourceState = Readonly<{
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
}>;

export type BackendArcNetworkConfiguration = Readonly<{
  key: ArcNetworkKey;
  chainId: number;
  environment: 'testnet' | 'mainnet';
  rpcUrl: string;
  explorerBaseUrl: string;
  tokens: Readonly<{
    USDC: ArcTokenResourceValue;
    EURC: ArcTokenResourceValue;
  }>;
  contracts: Readonly<{
    wizpay: ArcWizPayContractValue;
    wizpaySwapExecutorV2: ArcWizPayContractValue;
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

export function resolveBackendArcNetworkResourceState(
  selector: unknown,
): BackendArcNetworkResourceState {
  const key = parseArcNetworkKey(selector);
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
    },
    uniswapSwapRouter02: getArcProtocolContractResource(
      key,
      'uniswap-v3',
      'swapRouter02',
    ),
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
    config.contracts.wizpay.address,
  );
  assertExactLegacyValue(
    'NEXT_PUBLIC_WIZPAY_ADDRESS',
    environment.NEXT_PUBLIC_WIZPAY_ADDRESS,
    config.contracts.wizpay.address,
  );
  assertExactLegacyValue(
    'WIZPAY_SWAP_EXECUTOR_V2_ADDRESS',
    environment.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS,
    config.contracts.wizpaySwapExecutorV2.address,
  );
}

export function requireBackendArcNetworkReadiness(
  state: BackendArcNetworkResourceState,
): BackendArcNetworkConfiguration {
  const rpc = requireAvailableArcResource(state.rpc);
  const explorer = requireAvailableArcResource(state.explorer);
  const usdc = requireAvailableArcResource(state.tokens.USDC);
  const eurc = requireAvailableArcResource(state.tokens.EURC);
  const wizpay = requireAvailableArcResource(state.contracts.wizpay);
  const wizpaySwapExecutorV2 = requireAvailableArcResource(
    state.contracts.wizpaySwapExecutorV2,
  );

  return deepFreeze({
    key: state.key,
    chainId: state.network.chainId,
    environment: state.network.environment,
    rpcUrl: rpc.url,
    explorerBaseUrl: explorer.baseUrl,
    tokens: { USDC: usdc, EURC: eurc },
    contracts: { wizpay, wizpaySwapExecutorV2 },
  });
}

export function loadBackendArcNetworkConfiguration(
  environment: ArcNetworkEnvironment = process.env,
): BackendArcNetworkConfiguration {
  const key = parseArcNetworkKey(environment.WIZPAY_ARC_NETWORK);
  resolveArcCapabilities(key, environment);
  const state = resolveBackendArcNetworkResourceState(key);
  const config = requireBackendArcNetworkReadiness(state);
  validateLegacyActiveConfiguration(config, environment);
  return config;
}
