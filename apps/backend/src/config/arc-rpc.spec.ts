import { resolveArcRpcUrl } from './arc-rpc';

describe('canonical Arc RPC configuration', () => {
  it('resolves Arc Testnet only from an explicit selector', () => {
    expect(resolveArcRpcUrl('arc-testnet')).toBe('https://rpc.testnet.arc.io');
  });

  it.each([undefined, '', ' arc-testnet ', 'ARC-TESTNET', 'unknown'])(
    'rejects an inexact selector: %p',
    (selector) => {
      expect(() => resolveArcRpcUrl(selector)).toThrow();
    },
  );

  it('does not return the Testnet RPC for Arc Mainnet', () => {
    expect(() => resolveArcRpcUrl('arc-mainnet')).toThrow(
      'OFFICIAL_ARC_MAINNET_RPC_UNAVAILABLE',
    );
  });

  it('rejects alternate and whitespace-modified active RPC values', () => {
    for (const value of [
      'https://alternate.invalid',
      ' https://rpc.testnet.arc.io ',
    ]) {
      expect(() =>
        resolveArcRpcUrl('arc-testnet', [{ name: 'ARC_RPC_URL', value }]),
      ).toThrow('ARC_RPC_URL conflicts with WIZPAY_ARC_NETWORK.');
    }
  });
});
