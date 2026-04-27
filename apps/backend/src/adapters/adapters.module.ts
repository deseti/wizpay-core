import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { CircleService } from './circle.service';
import { CircleAdapter } from './circle/circle.adapter';
import { DexService } from './dex.service';

@Module({
  providers: [BlockchainService, CircleService, CircleAdapter, DexService],
  exports: [BlockchainService, CircleService, CircleAdapter, DexService],
})
export class AdaptersModule {}