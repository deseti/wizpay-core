import { BadRequestException } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

describe('WalletController register-external', () => {
  const registerExternalWallet = jest.fn();
  const walletAuth = { createChallenge: jest.fn(), verifyChallenge: jest.fn(), revoke: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function controller() {
    return new WalletController(
      { registerExternalWallet } as unknown as WalletService,
      walletAuth as never,
    );
  }

  it('retires caller-controlled external wallet registration', () => {
    expect(() => controller().registerExternal()).toThrow(BadRequestException);
    expect(registerExternalWallet).not.toHaveBeenCalled();
  });
});
