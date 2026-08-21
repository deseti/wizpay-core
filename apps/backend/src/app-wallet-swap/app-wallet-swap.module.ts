import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { DatabaseModule } from '../database/database.module';
import { WalletModule } from '../modules/wallet/wallet.module';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapDepositService } from './app-wallet-swap-deposit.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapOperationRepository } from './app-wallet-swap-operation.repository';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { AppWalletSwapRefundService } from './app-wallet-swap-refund.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import { AppWalletSwapController } from './app-wallet-swap.controller';
import { AppWalletSwapService } from './app-wallet-swap.service';
import { AppWalletSwapStablefxExecutorService } from './app-wallet-swap-stablefx-executor.service';
import { AppWalletXylonetUserControlledExecutorService } from './app-wallet-xylonet-user-controlled-executor.service';

@Module({
  imports: [AdaptersModule, DatabaseModule, UserSwapModule, WalletModule],
  controllers: [AppWalletSwapController],
  providers: [
    AppWalletSwapCircleExecutorService,
    AppWalletSwapDepositVerifierService,
    AppWalletSwapDepositService,
    AppWalletSwapTreasuryVerifierService,
    AppWalletSwapOperationRepository,
    AppWalletSwapPayoutExecutorService,
    AppWalletSwapRefundService,
    AppWalletSwapStablefxExecutorService,
    AppWalletXylonetUserControlledExecutorService,
    AppWalletSwapService,
  ],
})
export class AppWalletSwapModule {}
