/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await */
import { ConfigService } from '@nestjs/config';
import { InvoiceAuthService } from './invoice-auth.service';

const ARC = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';

describe('InvoiceAuthService', () => {
  const prisma = { userWallet: { findMany: jest.fn() } };
  const config = {
    get: jest.fn((key: string) =>
      key === 'CIRCLE_API_KEY' ? 'TEST_API_KEY:id:secret' : undefined,
    ),
  } as unknown as ConfigService;
  let service: InvoiceAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InvoiceAuthService(config, prisma as never);
    prisma.userWallet.findMany.mockResolvedValue([
      {
        blockchain: 'ARC-TESTNET',
        address: ARC,
        walletId: 'arc-wallet',
        userId: 'circle:user:circle-user',
        userEmail: 'merchant@example.com',
      },
      {
        blockchain: 'ETH-SEPOLIA',
        address: ARC.toLowerCase(),
        walletId: 'eth-wallet',
        userId: 'circle:user:circle-user',
        userEmail: 'merchant@example.com',
      },
    ]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 'circle-user', status: 'ENABLED' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            wallets: [
              {
                id: 'arc-wallet',
                userId: 'circle-user',
                address: ARC,
                blockchain: 'ARC-TESTNET',
              },
            ],
          },
        }),
      });
  });

  it('derives the merchant solely from the Circle-authenticated user and persisted canonical Arc wallet', async () => {
    await expect(
      service.authenticate('Bearer circle-session-token'),
    ).resolves.toEqual({
      merchantUserId: 'circle:user:circle-user',
      merchantWalletAddress: ARC,
      merchantDisplayLabel: null,
    });
    expect(prisma.userWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'circle:user:circle-user',
          blockchain: { in: ['ARC-TESTNET', 'ETH-SEPOLIA'] },
        },
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.circle.com/v1/w3s/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-User-Token': 'circle-session-token',
        }),
      }),
    );
  });

  it('rejects missing or malformed bearer authentication without calling Circle', async () => {
    await expect(service.authenticate(undefined)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.authenticate('Bearer token with spaces'),
    ).rejects.toMatchObject({ status: 401 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails closed when Circle rejects the token or omits identity', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(service.authenticate('Bearer bad')).rejects.toMatchObject({
      status: 401,
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    await expect(
      service.authenticate('Bearer missing-id'),
    ).rejects.toMatchObject({ status: 401 });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'circle-user', status: 'DISABLED' } }),
    });
    await expect(
      service.authenticate('Bearer disabled-user'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('fails closed for missing Arc wallet, conflicting EVM addresses, or unproven Circle ownership', async () => {
    prisma.userWallet.findMany.mockResolvedValueOnce([]);
    await expect(service.authenticate('Bearer token')).rejects.toMatchObject({
      status: 401,
    });

    prisma.userWallet.findMany.mockResolvedValueOnce([
      {
        blockchain: 'ARC-TESTNET',
        address: ARC,
        walletId: 'arc-wallet',
        userId: 'circle:user:circle-user',
      },
      {
        blockchain: 'ETH-SEPOLIA',
        address: '0x1111111111111111111111111111111111111111',
        walletId: 'eth-wallet',
        userId: 'circle:user:circle-user',
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'circle-user' } }),
    });
    await expect(service.authenticate('Bearer token')).rejects.toMatchObject({
      status: 401,
    });

    prisma.userWallet.findMany.mockResolvedValueOnce([
      {
        blockchain: 'ARC-TESTNET',
        address: ARC,
        walletId: 'arc-wallet',
        userId: 'circle:user:circle-user',
      },
    ]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 'circle-user' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            wallets: [
              {
                id: 'other-wallet',
                userId: 'circle-user',
                address: ARC,
                blockchain: 'ARC-TESTNET',
              },
            ],
          },
        }),
      });
    await expect(service.authenticate('Bearer token')).rejects.toMatchObject({
      status: 401,
    });
  });
});
