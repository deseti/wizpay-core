import { Test } from '@nestjs/testing';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { PrismaService } from '../database/prisma.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import { UserSwapService } from '../user-swap/user-swap.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapModule } from './app-wallet-swap.module';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { AppWalletSwapService } from './app-wallet-swap.service';
import { AppWalletSwapStablefxExecutorService } from './app-wallet-swap-stablefx-executor.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';

describe('AppWalletSwapModule wiring', () => {
  const appWalletProviders = [
    AppWalletSwapCircleExecutorService,
    AppWalletSwapDepositVerifierService,
    AppWalletSwapTreasuryVerifierService,
    AppWalletSwapOperationRepository,
    AppWalletSwapPayoutExecutorService,
    AppWalletSwapStablefxExecutorService,
    AppWalletSwapService,
  ];

  it('registers every App Wallet provider exactly once', () => {
    const providers = Reflect.getMetadata(
      'providers',
      AppWalletSwapModule,
    ) as unknown[];

    for (const provider of appWalletProviders) {
      expect(
        providers.filter((candidate) => candidate === provider),
      ).toHaveLength(1);
    }
  });

  it('compiles the production constructor graph with mocked upstream boundaries', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...appWalletProviders,
        { provide: UserSwapService, useValue: {} },
        { provide: CircleService, useValue: {} },
        { provide: W3sAuthService, useValue: {} },
        { provide: BlockchainService, useValue: {} },
        { provide: StablefxExecutionService, useValue: {} },
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(AppWalletSwapService)).toBeInstanceOf(
      AppWalletSwapService,
    );
    expect(moduleRef.get(AppWalletSwapOperationRepository)).toBeInstanceOf(
      AppWalletSwapOperationRepository,
    );
    expect(moduleRef.get(AppWalletSwapPayoutExecutorService)).toBeInstanceOf(
      AppWalletSwapPayoutExecutorService,
    );
  });
});
