import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { WalletModule } from '../modules/wallet/wallet.module';
import { AppWalletSwapController } from './app-wallet-swap.controller';
import { AppWalletXylonetUserControlledExecutorService } from './app-wallet-xylonet-user-controlled-executor.service';

@Module({
  imports: [DatabaseModule, WalletModule],
  controllers: [AppWalletSwapController],
  providers: [AppWalletXylonetUserControlledExecutorService],
})
export class AppWalletSwapModule {}
