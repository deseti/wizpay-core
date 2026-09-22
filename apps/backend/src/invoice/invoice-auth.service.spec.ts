import { InvoiceAuthService } from './invoice-auth.service';

const WALLET = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';

describe('InvoiceAuthService', () => {
  const walletAuth = { authenticate: jest.fn() };
  let service: InvoiceAuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InvoiceAuthService(walletAuth as never);
    walletAuth.authenticate.mockResolvedValue({
      merchantUserId: 'wallet-user-a',
      merchantWalletAddress: WALLET,
      merchantDisplayLabel: null,
    });
  });

  it('derives the merchant from the registered external Arc Mainnet wallet', async () => {
    await expect(service.authenticate(`Bearer ${WALLET}`)).resolves.toEqual({
      merchantUserId: 'wallet-user-a',
      merchantWalletAddress: WALLET,
      merchantDisplayLabel: null,
    });
    expect(walletAuth.authenticate).toHaveBeenCalledWith(`Bearer ${WALLET}`);
  });

  it('rejects missing or malformed bearer authentication without a registry read', async () => {
    const error = Object.assign(new Error('unauthorized'), { status: 401 });
    walletAuth.authenticate.mockRejectedValue(error);
    await expect(service.authenticate(undefined)).rejects.toBe(error);
    expect(walletAuth.authenticate).toHaveBeenCalledWith(undefined);
  });
});
