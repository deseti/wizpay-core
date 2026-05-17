import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { DatabaseModule } from '../database/database.module';
import { WalletModule } from '../modules/wallet/wallet.module';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { AppWalletSwapDepositVerifierService } from './app-wallet-swap-deposit-verifier.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import { AppWalletSwapController } from './app-wallet-swap.controller';
import { AppWalletSwapService } from './app-wallet-swap.service';

@Module({
  imports: [AdaptersModule, DatabaseModule, UserSwapModule, WalletModule],
  controllers: [AppWalletSwapController],
  providers: [
    AppWalletSwapDepositVerifierService,
    AppWalletSwapTreasuryVerifierService,
    AppWalletSwapService,
  ],
})
export class AppWalletSwapModule {}
