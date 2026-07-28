import { ConfigService } from '@nestjs/config';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { UserSwapService } from '../user-swap/user-swap.service';
import { PayrollFxStablefxLifecycleService } from './payroll-fx-stablefx-lifecycle.service';

describe('Payroll FX Phase 2 provider isolation', () => {
  const treasury = '0x1111111111111111111111111111111111111111';
  const request = {
    sourceToken: 'USDC',
    targetToken: 'EURC',
    sourceAmount: '30000000',
    referenceId: 'phase-2-provider-isolation',
    walletAddress: '0x2222222222222222222222222222222222222222',
  };

  function createService(provider: string | undefined) {
    const config: Record<string, string | undefined> = {
      WIZPAY_USER_SWAP_ENABLED: 'true',
      WIZPAY_USER_SWAP_ALLOW_TESTNET: 'true',
      WIZPAY_USER_SWAP_KIT_KEY: 'test-kit-key',
      APP_WALLET_TREASURY_SWAP_EXECUTION_ENABLED: 'true',
      CIRCLE_WALLET_ID_ARC: 'treasury-wallet-id',
      CIRCLE_WALLET_ADDRESS_ARC: treasury,
      WIZPAY_SWAP_PROVIDER: provider,
    };
    const lifecycle = {
      settle: jest.fn().mockResolvedValue({
        sourceToken: 'USDC',
        targetToken: 'EURC',
        sourceAmount: '30000000',
        targetAmount: '29700000',
        txHash: `0x${'b'.repeat(64)}`,
        status: 'settled',
        operationId: '8d00c7ac-d036-4448-94ea-2f38a51e64d8',
      }),
    };
    const userSwap = {
      prepare: jest.fn().mockResolvedValue({
        expectedOutput: '29700000',
        minimumOutput: '29400000',
        transaction: {
          to: '0x3333333333333333333333333333333333333333',
          data: '0x1234',
        },
      }),
    };
    const circle = {
      executeContract: jest.fn().mockResolvedValue({
        txId: 'swap-transaction-id',
        txHash: `0x${'a'.repeat(64)}`,
      }),
      waitForTransactionComplete: jest.fn().mockResolvedValue({
        txHash: `0x${'a'.repeat(64)}`,
        status: 'COMPLETE',
      }),
    };
    const service = new PayrollFxSettlementService(
      userSwap as unknown as UserSwapService,
      circle as unknown as CircleService,
      {
        get: jest.fn((key: string) => config[key]),
      } as unknown as ConfigService,
      {} as StablefxExecutionService,
      {} as BlockchainService,
      lifecycle as unknown as PayrollFxStablefxLifecycleService,
    );

    return { service, lifecycle, userSwap };
  }

  it('resolves the provider once and delegates only StableFX to the durable lifecycle', async () => {
    const { service, lifecycle, userSwap } = createService('stablefx');
    const resolver = jest.spyOn(
      service as unknown as { isStablefxProviderSelected: () => boolean },
      'isStablefxProviderSelected',
    );

    await expect(service.settle(request)).resolves.toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      operationId: expect.any(String),
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(lifecycle.settle).toHaveBeenCalledWith(request, treasury);
    expect(userSwap.prepare).not.toHaveBeenCalled();
  });

  it.each([undefined, 'unsupported-provider'])(
    'leaves the current SwapKit/unknown-provider path outside PayrollFxOperation (%s)',
    async (provider) => {
      const { service, lifecycle, userSwap } = createService(provider);

      await expect(service.settle(request)).resolves.toMatchObject({
        status: 'settled',
      });
      expect(userSwap.prepare).toHaveBeenCalledTimes(1);
      expect(lifecycle.settle).not.toHaveBeenCalled();
    },
  );
});
