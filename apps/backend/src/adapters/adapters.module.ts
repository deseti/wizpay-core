import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { CircleService } from './circle.service';
import { CircleAdapter } from './circle/circle.adapter';
import { CircleBridgeService } from './circle/circle-bridge.service';
import { CircleClient } from './circle/circle.client';
import { CircleTransferService } from './circle/circle-transfer.service';
import { DexService } from './dex.service';

@Module({
  providers: [
    BlockchainService,
    CircleService,
    CircleAdapter,
    CircleBridgeService,
    CircleClient,
    CircleTransferService,
    DexService,
  ],
  exports: [
    BlockchainService,
    CircleService,
    CircleAdapter,
    CircleBridgeService,
    CircleClient,
    CircleTransferService,
    DexService,
  ],
})
export class AdaptersModule {}
