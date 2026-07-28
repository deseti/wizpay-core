import { ConfigService } from '@nestjs/config';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';
import type { PayrollFxStablefxRecoveryService } from './payroll-fx-stablefx-recovery.service';

describe('Payroll FX Phase 3 persisted provider immutability', () => {
  it('resumes persisted StableFX even after environment selection changes to SwapKit', async () => {
    const treasury = '0x1111111111111111111111111111111111111111';
    const request = {
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30000000',
      referenceId: 'persisted-stablefx',
      walletAddress: '0x2222222222222222222222222222222222222222',
    };
    const userSwap = { prepare: jest.fn() };
    const lifecycle = { settle: jest.fn() };
    const recovery = {
      hasExistingOperation: jest.fn().mockResolvedValue(true),
      settle: jest.fn().mockResolvedValue({
        ...request,
        targetAmount: '29700000',
        txHash: `0x${'a'.repeat(64)}`,
        status: 'settled',
        operationId: '8d00c7ac-d036-4448-94ea-2f38a51e64d8',
      }),
    };
    const config: Record<string, string> = {
      WIZPAY_USER_SWAP_ENABLED: 'true',
      WIZPAY_USER_SWAP_ALLOW_TESTNET: 'true',
      WIZPAY_USER_SWAP_KIT_KEY: 'kit-key',
      APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED: 'true',
      CIRCLE_WALLET_ID_ARC: 'wallet-id',
      CIRCLE_WALLET_ADDRESS_ARC: treasury,
      WIZPAY_SWAP_PROVIDER: 'swapkit',
    };
    const service = new PayrollFxSettlementService(
      userSwap as never,
      {} as never,
      {
        get: jest.fn((key: string) => config[key]),
      } as unknown as ConfigService,
      {} as never,
      {} as never,
      lifecycle as never,
      recovery as unknown as PayrollFxStablefxRecoveryService,
    );

    await service.settle(request);

    expect(recovery.settle).toHaveBeenCalledWith(request, treasury);
    expect(userSwap.prepare).not.toHaveBeenCalled();
    expect(lifecycle.settle).not.toHaveBeenCalled();
  });
});
