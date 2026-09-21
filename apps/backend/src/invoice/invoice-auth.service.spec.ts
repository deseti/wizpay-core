import { InvoiceAuthService } from './invoice-auth.service';

const WALLET = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';

describe('InvoiceAuthService', () => {
  const prisma = { userWallet: { findMany: jest.fn() } };
  let service: InvoiceAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InvoiceAuthService(prisma as never);
    prisma.userWallet.findMany.mockResolvedValue([
      {
        blockchain: 'ARC-MAINNET',
        address: WALLET,
        walletId: `external:arc-mainnet:${WALLET.toLowerCase()}`,
        walletSetId: null,
        userId: 'wallet-user-a',
        userEmail: 'merchant@example.com',
      },
    ]);
  });

  it('derives the merchant from the registered external Arc Mainnet wallet', async () => {
    await expect(service.authenticate(`Bearer ${WALLET}`)).resolves.toEqual({
      merchantUserId: 'wallet-user-a',
      merchantWalletAddress: WALLET,
      merchantDisplayLabel: null,
    });
    expect(prisma.userWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockchain: 'ARC-MAINNET' },
      }),
    );
  });

  it('rejects missing or malformed bearer authentication without a registry read', async () => {
    await expect(service.authenticate(undefined)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.authenticate('Bearer not-an-address'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.authenticate('Bearer token with spaces'),
    ).rejects.toMatchObject({ status: 401 });
    expect(prisma.userWallet.findMany).not.toHaveBeenCalled();
  });

  it('fails closed when the address has no registered external wallet', async () => {
    prisma.userWallet.findMany.mockResolvedValue([]);
    await expect(
      service.authenticate(`Bearer ${WALLET}`),
    ).rejects.toMatchObject({
      status: 401,
      response: expect.objectContaining({ code: 'INVOICE_ARC_WALLET_MISSING' }),
    });
  });

  it('fails closed for conflicting registry owners of one address', async () => {
    prisma.userWallet.findMany.mockResolvedValue([
      {
        blockchain: 'ARC-MAINNET',
        address: WALLET,
        walletId: 'external-a',
        userId: 'wallet-user-a',
      },
      {
        blockchain: 'ARC-MAINNET',
        address: WALLET.toLowerCase(),
        walletId: 'external-b',
        userId: 'wallet-user-b',
      },
    ]);
    await expect(
      service.authenticate(`Bearer ${WALLET}`),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('ignores registry rows from other networks', async () => {
    prisma.userWallet.findMany.mockImplementation(async ({ where }: any) =>
      where.blockchain === 'ARC-MAINNET'
        ? []
        : [
            {
              blockchain: where.blockchain,
              address: WALLET,
              walletId: 'external-other',
              userId: 'wallet-user-a',
            },
          ],
    );
    await expect(
      service.authenticate(`Bearer ${WALLET}`),
    ).rejects.toMatchObject({ status: 401 });
  });
});
