import { ConfigService } from '@nestjs/config';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { CircleClient } from './circle.client';

jest.mock('@circle-fin/developer-controlled-wallets', () => ({
  initiateDeveloperControlledWalletsClient: jest.fn().mockReturnValue({}),
}));

function config(network: 'arc-testnet' | 'arc-mainnet', overrides = {}) {
  const values: Record<string, unknown> = {
    'arcNetwork.key': network,
    CIRCLE_TESTNET_API_BASE_URL: 'https://api.circle.test',
    CIRCLE_TESTNET_API_KEY: 'test-api-key',
    CIRCLE_TESTNET_ENTITY_SECRET: 'test-entity-secret',
    CIRCLE_TESTNET_WALLET_SET_ID: 'test-wallet-set',
    CIRCLE_TESTNET_WALLET_ID: 'test-wallet-id',
    CIRCLE_TESTNET_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    CIRCLE_TESTNET_RECEIPT_CONFIRMATIONS: '2',
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`Missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
}

describe('CircleClient construction boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('constructs lazily from only the selected Testnet configuration', () => {
    const client = new CircleClient(config('arc-testnet'));
    expect(initiateDeveloperControlledWalletsClient).not.toHaveBeenCalled();

    client.getWalletClient();

    expect(initiateDeveloperControlledWalletsClient).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      entitySecret: 'test-entity-secret',
      baseUrl: 'https://api.circle.test',
    });
  });

  it('does not construct a Mainnet client while the blockchain is unverified', () => {
    const client = new CircleClient(
      config('arc-mainnet', {
        CIRCLE_TESTNET_API_BASE_URL: undefined,
        CIRCLE_TESTNET_API_KEY: undefined,
        CIRCLE_TESTNET_ENTITY_SECRET: undefined,
        CIRCLE_TESTNET_WALLET_SET_ID: undefined,
        CIRCLE_TESTNET_WALLET_ID: undefined,
        CIRCLE_TESTNET_WALLET_ADDRESS: undefined,
        CIRCLE_TESTNET_RECEIPT_CONFIRMATIONS: undefined,
        CIRCLE_MAINNET_API_BASE_URL: 'https://api.circle.com',
        CIRCLE_MAINNET_API_KEY: 'mainnet-api-key',
      }),
    );

    expect(() => client.getWalletClient()).toThrow('unverified');
    expect(initiateDeveloperControlledWalletsClient).not.toHaveBeenCalled();
  });

  it('does not construct a client from missing or generic credentials', () => {
    const client = new CircleClient(
      config('arc-testnet', {
        CIRCLE_TESTNET_API_KEY: undefined,
        CIRCLE_API_KEY: 'generic-secret-value',
      }),
    );

    expect(() => client.getWalletClient()).toThrow();
    expect(initiateDeveloperControlledWalletsClient).not.toHaveBeenCalled();
  });
});
