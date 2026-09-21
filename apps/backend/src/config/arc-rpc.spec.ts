import { resolveArcRpcUrl } from './arc-rpc';

describe('canonical Arc RPC configuration', () => {
  it('resolves Arc Mainnet only from an exact selector', () => {
    expect(resolveArcRpcUrl('arc-mainnet')).toBe('https://rpc.mainnet.arc.io');
  });

  it.each([
    undefined,
    '',
    ' arc-mainnet ',
    'ARC-MAINNET',
    'unknown',
    'arc-mainnet-v2',
  ])('rejects an inexact selector: %p', (selector) => {
    expect(() => resolveArcRpcUrl(selector)).toThrow();
  });

  it('rejects alternate and whitespace-modified active RPC values', () => {
    for (const value of [
      'https://alternate.invalid',
      ' https://rpc.mainnet.arc.io ',
    ]) {
      expect(() =>
        resolveArcRpcUrl('arc-mainnet', [{ name: 'ARC_RPC_URL', value }]),
      ).toThrow('ARC_RPC_URL conflicts with WIZPAY_ARC_NETWORK.');
    }
  });

  it('accepts an exact Mainnet RPC override value', () => {
    expect(
      resolveArcRpcUrl('arc-mainnet', [
        { name: 'ARC_RPC_URL', value: 'https://rpc.mainnet.arc.io' },
      ]),
    ).toBe('https://rpc.mainnet.arc.io');
  });
});
