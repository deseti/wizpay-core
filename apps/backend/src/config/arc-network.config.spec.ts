import {
  loadBackendArcNetworkConfiguration,
  requireBackendArcNetworkReadiness,
  resolveBackendArcNetworkResourceState,
} from './arc-network.config';

const MAINNET_RPC = 'https://rpc.mainnet.arc.io';
const MAINNET_EXPLORER = 'https://explorer.arc.io';
const MAINNET_USDC = '0x3600000000000000000000000000000000000000';
const MAINNET_EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const MAINNET_WIZPAY = '0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34';
const MAINNET_EXECUTOR = '0x7A051F17B237750EF9D4E63fb75381B9F8755774';

describe('backend Arc network configuration', () => {
  it('creates the exact immutable Arc Mainnet configuration', () => {
    const state = resolveBackendArcNetworkResourceState('arc-mainnet');
    const config = loadBackendArcNetworkConfiguration({
      WIZPAY_ARC_NETWORK: 'arc-mainnet',
    });

    expect(config).toMatchObject({
      key: 'arc-mainnet',
      chainId: 5_042,
      environment: 'mainnet',
      rpcUrl: MAINNET_RPC,
      explorerBaseUrl: MAINNET_EXPLORER,
      tokens: {
        USDC: { address: MAINNET_USDC },
        EURC: { address: MAINNET_EURC },
      },
      contracts: {
        wizpay: { address: MAINNET_WIZPAY, contract: 'WizPayPayrollMainnet' },
        wizpaySwapExecutorMainnet: { address: MAINNET_EXECUTOR },
      },
    });
    expect(config.contracts).not.toHaveProperty('wizpaySwapExecutorV2');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.tokens)).toBe(true);
    expect(Object.isFrozen(config.contracts)).toBe(true);
    expect(state.uniswapSwapRouter02).toMatchObject({
      status: 'published',
      executable: false,
    });
    expect(state.mainnetUniswapV4).toMatchObject({
      network: 'arc-mainnet',
      chainId: 5_042,
      capabilityEnabled: false,
      executable: false,
      poolKey: { status: 'candidate', executable: false },
      poolId: { status: 'candidate', executable: false },
      poolUniqueness: { status: 'unavailable' },
    });
  });

  it.each([undefined, '', ' arc-mainnet ', 'ARC-MAINNET', 'unknown', 'arc-mainnet-v2'])(
    'rejects missing or inexact selectors: %p',
    (selector) => {
      expect(() =>
        loadBackendArcNetworkConfiguration({
          WIZPAY_ARC_NETWORK: selector,
        }),
      ).toThrow();
      expect(() => resolveBackendArcNetworkResourceState(selector)).toThrow();
    },
  );

  it('fails closed when a required Mainnet resource is unavailable', () => {
    const state = resolveBackendArcNetworkResourceState('arc-mainnet');
    expect(() =>
      requireBackendArcNetworkReadiness({
        ...state,
        rpc: {
          status: 'unavailable',
          reason: 'OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE',
        },
      }),
    ).toThrow();
    expect(() =>
      requireBackendArcNetworkReadiness({
        ...state,
        explorer: {
          status: 'unavailable',
          reason: 'OFFICIAL_ARC_MAINNET_EXPLORER_UNAVAILABLE',
        },
      }),
    ).toThrow();
  });

  it.each([
    ['RPC_URL', 'https://alternate.invalid'],
    ['ARC_RPC_URL', ` ${MAINNET_RPC} `],
    ['NEXT_PUBLIC_RPC_URL', 'https://alternate.invalid'],
    ['CHAIN_ID', '1'],
    ['NEXT_PUBLIC_WIZPAY_ADDRESS', MAINNET_EXECUTOR],
    ['WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS', MAINNET_WIZPAY],
  ])('rejects conflicting legacy active configuration %s', (name, value) => {
    expect(() =>
      loadBackendArcNetworkConfiguration({
        WIZPAY_ARC_NETWORK: 'arc-mainnet',
        [name]: value,
      }),
    ).toThrow(`${name} conflicts with WIZPAY_ARC_NETWORK.`);
  });
});
