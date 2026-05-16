import { Module } from '@nestjs/common';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { AppWalletSwapController } from './app-wallet-swap.controller';
import { AppWalletSwapService } from './app-wallet-swap.service';

@Module({
  imports: [UserSwapModule],
  controllers: [AppWalletSwapController],
  providers: [AppWalletSwapService],
})
export class AppWalletSwapModule {}
