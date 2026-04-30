import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { W3sAuthController } from './w3s-auth.controller';
import { W3sAuthService } from './w3s-auth.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [DatabaseModule],
  controllers: [WalletController, W3sAuthController],
  providers: [WalletService, W3sAuthService],
  exports: [WalletService],
})
export class WalletModule {}