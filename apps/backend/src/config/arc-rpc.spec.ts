import { ARC_TESTNET_RPC_URL, resolveArcTestnetRpcUrl } from './arc-rpc';

describe('Arc Testnet RPC configuration', () => {
  it('uses the required endpoint when configuration is absent', () => {
    expect(
      resolveArcTestnetRpcUrl([
        { name: 'ARC_RPC_URL', value: undefined },
        { name: 'NEXT_PUBLIC_ARC_TESTNET_RPC_URL', value: '' },
      ]),
    ).toBe(ARC_TESTNET_RPC_URL);
  });

  it('accepts the required endpoint through supported environment variables', () => {
    expect(
      resolveArcTestnetRpcUrl([
        { name: 'ARC_RPC_URL', value: ARC_TESTNET_RPC_URL },
        {
          name: 'NEXT_PUBLIC_ARC_TESTNET_RPC_URL',
          value: `  ${ARC_TESTNET_RPC_URL}  `,
        },
      ]),
    ).toBe(ARC_TESTNET_RPC_URL);
  });

  it('rejects any alternate Arc Testnet RPC endpoint', () => {
    expect(() =>
      resolveArcTestnetRpcUrl([
        {
          name: 'ARC_RPC_URL',
          value: 'https://alternate.invalid',
        },
      ]),
    ).toThrow(`ARC_RPC_URL must be exactly ${ARC_TESTNET_RPC_URL}.`);
  });
});
