import { BadRequestException } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

const ADDRESS = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';

describe('WalletController register-external', () => {
  const registerExternalWallet = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function controller() {
    return new WalletController({
      registerExternalWallet,
    } as unknown as WalletService);
  }

  it('registers the caller-provided external wallet address', async () => {
    registerExternalWallet.mockResolvedValue({
      address: ADDRESS,
      userId: 'user-a',
    });
    await expect(
      controller().registerExternal({
        userId: 'user-a',
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({
      data: { address: ADDRESS, userId: 'user-a' },
    });
    expect(registerExternalWallet).toHaveBeenCalledWith({
      userId: 'user-a',
      address: ADDRESS,
      userEmail: null,
    });
  });

  it('fails closed for missing userId or malformed address', async () => {
    await expect(
      controller().registerExternal({ userId: '', address: ADDRESS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller().registerExternal({ userId: 'user-a', address: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(registerExternalWallet).not.toHaveBeenCalled();
  });
});
