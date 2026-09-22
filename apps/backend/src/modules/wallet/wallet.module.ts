import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletAuthService } from './wallet-auth.service';

@Module({
  imports: [DatabaseModule],
  controllers: [WalletController],
  providers: [WalletService, WalletAuthService],
  exports: [WalletService, WalletAuthService],
})
export class WalletModule {}
