import { ConfigService } from '@nestjs/config';
import { WalletService } from './wallet.service';

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'arcNetwork.key': 'arc-testnet',
    CIRCLE_TESTNET_API_BASE_URL: 'https://api.circle.test',
    CIRCLE_TESTNET_API_KEY: 'test-api-key',
    CIRCLE_TESTNET_APP_ID: 'testnet-app-id',
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

describe('WalletService Circle network isolation', () => {
  const originalFetch = global.fetch;
  const prisma = {
    userWallet: {
      findUnique: jest.fn(),
    },
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('creates wallets only with the selected verified Circle identifier', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { wallets: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { challengeId: 'challenge' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const service = new WalletService(config(), prisma as never);

    await expect(
      service.initializeWallets({
        userId: 'circle:user:test-user',
        userToken: 'test-user-token',
      }),
    ).resolves.toEqual({
      challengeId: 'challenge',
      userId: 'circle:user:test-user',
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.circle.test/v1/w3s/user/initialize',
      expect.objectContaining({
        body: expect.stringContaining('"blockchains":["ARC-TESTNET"]'),
      }),
    );
  });

  it('rejects cross-network and ambiguous persisted wallets', async () => {
    const service = new WalletService(config(), prisma as never);
    prisma.userWallet.findUnique.mockResolvedValue({
      userId: 'circle:user:test-user',
      walletId: 'wallet',
      blockchain: 'ETH-SEPOLIA',
      walletSetId: null,
    });

    await expect(
      service.getStoredWalletForSelectedArc('circle:user:test-user', 'wallet'),
    ).rejects.toMatchObject({ code: 'CIRCLE_WALLET_BLOCKCHAIN_MISMATCH' });

    prisma.userWallet.findUnique.mockResolvedValue(null);
    await expect(
      service.getStoredWalletForSelectedArc('circle:user:test-user', 'wallet'),
    ).rejects.toMatchObject({ code: 'CIRCLE_WALLET_BLOCKCHAIN_MISMATCH' });
  });

  it('rejects a persisted wallet from a different configured wallet set', async () => {
    const service = new WalletService(
      config({ CIRCLE_TESTNET_WALLET_SET_ID: 'selected-wallet-set' }),
      prisma as never,
    );
    prisma.userWallet.findUnique.mockResolvedValue({
      userId: 'circle:user:test-user',
      walletId: 'wallet',
      blockchain: 'ARC-TESTNET',
      walletSetId: 'other-wallet-set',
    });

    await expect(
      service.getStoredWalletForSelectedArc('circle:user:test-user', 'wallet'),
    ).rejects.toMatchObject({ code: 'CIRCLE_WALLET_SET_MISMATCH' });
  });
});
