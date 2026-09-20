import {
  loadBackendArcNetworkConfiguration,
  requireBackendArcNetworkReadiness,
  resolveBackendArcNetworkResourceState,
} from './arc-network.config';

const TESTNET_RPC = 'https://rpc.testnet.arc.io';
const TESTNET_USDC = '0x3600000000000000000000000000000000000000';
const TESTNET_EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const TESTNET_WIZPAY = '0x87ACE45582f45cC81AC1E627E875AE84cbd75946';
const TESTNET_EXECUTOR = '0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed';

describe('backend Arc network configuration', () => {
  it('creates the exact immutable Arc Testnet configuration', () => {
    const state = resolveBackendArcNetworkResourceState('arc-testnet');
    const config = loadBackendArcNetworkConfiguration({
      WIZPAY_ARC_NETWORK: 'arc-testnet',
    });

    expect(config).toMatchObject({
      key: 'arc-testnet',
      chainId: 5_042_002,
      rpcUrl: TESTNET_RPC,
      tokens: {
        USDC: { address: TESTNET_USDC },
        EURC: { address: TESTNET_EURC },
      },
      contracts: {
        wizpay: { address: TESTNET_WIZPAY },
        wizpaySwapExecutorV2: { address: TESTNET_EXECUTOR },
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.tokens)).toBe(true);
    expect(state.mainnetUniswapV4).toBeNull();
  });

  it.each([undefined, '', ' arc-testnet ', 'ARC-TESTNET', 'unknown'])(
    'rejects missing or inexact selectors: %p',
    (selector) => {
      expect(() =>
        loadBackendArcNetworkConfiguration({
          WIZPAY_ARC_NETWORK: selector,
        }),
      ).toThrow();
    },
  );

  it('recognizes Arc Mainnet without importing Testnet resources', () => {
    const state = resolveBackendArcNetworkResourceState('arc-mainnet');
    expect(state.key).toBe('arc-mainnet');
    expect(state.network.chainId).toBe(5_042);
    expect(state.rpc).not.toEqual(
      expect.objectContaining({ value: { url: TESTNET_RPC } }),
    );
    expect(state.tokens.USDC).toMatchObject({
      status: 'available',
      value: { address: TESTNET_USDC },
    });
    expect(state.tokens.EURC).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_EURC } }),
    );
    expect(state.contracts.wizpay).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_WIZPAY } }),
    );
    expect(state.contracts.wizpaySwapExecutorV2).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_EXECUTOR } }),
    );
    expect(state.uniswapSwapRouter02).toMatchObject({
      status: 'published',
      executable: false,
    });
    expect(state.mainnetUniswapV4).toMatchObject({
      chainId: 5_042,
      capabilityEnabled: false,
      executable: false,
      poolKey: { status: 'candidate', executable: false },
      poolId: { status: 'candidate', executable: false },
      poolUniqueness: { status: 'unavailable' },
    });
    const config = requireBackendArcNetworkReadiness(state);
    expect(config).toMatchObject({
      key: 'arc-mainnet',
      chainId: 5_042,
      rpcUrl: 'https://rpc.mainnet.arc.io',
      explorerBaseUrl: 'https://explorer.arc.io',
      tokens: {
        USDC: { address: TESTNET_USDC },
        EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' },
      },
      contracts: {
        wizpay: {
          contract: 'WizPayPayrollMainnet',
          address: '0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34',
        },
        wizpaySwapExecutorMainnet: {
          address: '0x7A051F17B237750EF9D4E63fb75381B9F8755774',
        },
      },
    });
    expect(config.contracts).not.toHaveProperty('wizpaySwapExecutorV2');
  });

  it('loads live Arc Mainnet configuration without enabling capabilities', () => {
    const config = loadBackendArcNetworkConfiguration({
      WIZPAY_ARC_NETWORK: 'arc-mainnet',
    });
    expect(config.chainId).toBe(5_042);
    expect(config.contracts.wizpay?.contract).toBe('WizPayPayrollMainnet');
    expect(config.contracts.wizpaySwapExecutorV2).toBeUndefined();
  });

  it.each([
    ['RPC_URL', 'https://alternate.invalid'],
    ['ARC_RPC_URL', ` ${TESTNET_RPC} `],
    ['NEXT_PUBLIC_RPC_URL', 'https://alternate.invalid'],
    ['CHAIN_ID', '5042'],
    ['NEXT_PUBLIC_WIZPAY_ADDRESS', TESTNET_EXECUTOR],
    ['WIZPAY_SWAP_EXECUTOR_V2_ADDRESS', TESTNET_WIZPAY],
  ])('rejects conflicting legacy active configuration %s', (name, value) => {
    expect(() =>
      loadBackendArcNetworkConfiguration({
        WIZPAY_ARC_NETWORK: 'arc-testnet',
        [name]: value,
      }),
    ).toThrow(`${name} conflicts with WIZPAY_ARC_NETWORK.`);
  });
});
