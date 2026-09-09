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
    expect(state.tokens.USDC).not.toEqual(
      expect.objectContaining({ value: { address: TESTNET_USDC } }),
    );
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
    expect(() => requireBackendArcNetworkReadiness(state)).toThrow(
      'OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE',
    );
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
