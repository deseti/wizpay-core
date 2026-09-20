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

  it('resolves the live Arc Mainnet RPC without returning the Testnet RPC', () => {
    expect(resolveArcRpcUrl('arc-mainnet')).toBe('https://rpc.mainnet.arc.io');
    expect(resolveArcRpcUrl('arc-mainnet')).not.toBe(
      'https://rpc.testnet.arc.io',
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
