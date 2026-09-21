import {
  EXTERNAL_WALLET_BLOCKCHAIN,
  WalletService,
} from './wallet.service';

const ADDRESS = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';

function stored(overrides: Record<string, unknown> = {}) {
  return {
    address: ADDRESS,
    blockchain: EXTERNAL_WALLET_BLOCKCHAIN,
    chain: 'EVM',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    userEmail: null,
    userId: 'user-a',
    walletId: `external:arc-mainnet:${ADDRESS.toLowerCase()}`,
    walletSetId: null,
    ...overrides,
  };
}

describe('WalletService Mainnet isolation', () => {
  const prisma = {
    userWallet: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function service() {
    return new WalletService(config as never, prisma as never);
  }

  it('registers an external wallet on Arc Mainnet (chain 5042) only', async () => {
    prisma.userWallet.findUnique.mockResolvedValue(null);
    prisma.userWallet.upsert.mockImplementation(async ({ create }: any) => ({
      ...stored(),
      ...create,
    }));

    const wallet = await service().registerExternalWallet({
      userId: 'user-a',
      address: ADDRESS,
    });

    expect(wallet).toMatchObject({
      address: ADDRESS,
      blockchain: 'ARC-MAINNET',
      chain: 'EVM',
      chainId: 5042,
      userId: 'user-a',
      walletSetId: null,
    });
    expect(prisma.userWallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_blockchain: {
            userId: 'user-a',
            blockchain: 'ARC-MAINNET',
          },
        },
      }),
    );
  });

  it('rejects invalid addresses and conflicting registrations', async () => {
    await expect(
      service().registerExternalWallet({ userId: 'user-a', address: 'nope' }),
    ).rejects.toMatchObject({ status: 400 });

    prisma.userWallet.findUnique.mockResolvedValue(
      stored({ userId: 'user-b' }),
    );
    await expect(
      service().registerExternalWallet({ userId: 'user-a', address: ADDRESS }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'WALLET_ALREADY_EXISTS',
    });
  });

  it('looks up the registry only on ARC-MAINNET', async () => {
    prisma.userWallet.findUnique.mockResolvedValue(stored());
    await expect(
      service().getStoredWalletByBlockchain('user-a', 'ARC-MAINNET'),
    ).resolves.toMatchObject({ chainId: 5042 });
    await expect(
      service().getStoredWalletByBlockchain('user-a', 'OTHER' as never),
    ).resolves.toBeNull();
  });

  it.each([['initializeWallets'], ['syncWallets'], ['getOrCreateWallet']])(
    'fails closed for retired provider wallet flow %s',
    async (method) => {
      await expect(
        (service() as never as Record<string, (input: never) => unknown>)[
          method
        ]({ userToken: 'token' } as never),
      ).rejects.toMatchObject({
        status: 503,
        code: 'WALLET_PROVISIONING_RETIRED',
      });
    },
  );

  it('fails closed when a provider wallet resource is requested', async () => {
    await expect(
      service().getStoredWalletForSelectedArc('user-a', 'wallet-id'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'WALLET_PROVISIONING_RETIRED',
    });
  });
});
