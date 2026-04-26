import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { CircleService } from './circle.service';
import { DexService } from './dex.service';

@Module({
  providers: [BlockchainService, CircleService, DexService],
  exports: [BlockchainService, CircleService, DexService],
})
export class AdaptersModule {}