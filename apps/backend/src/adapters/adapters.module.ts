import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { CircleService } from './circle.service';
import { CircleAdapter } from './circle/circle.adapter';
import { CircleBridgeService } from './circle/circle-bridge.service';
import { CircleClient } from './circle/circle.client';
import { CircleTransferService } from './circle/circle-transfer.service';
import { DexService } from './dex.service';
import { SolanaService } from './solana.service';

const ADAPTER_SERVICES = [
  BlockchainService,
  CircleService,
  CircleAdapter,
  CircleBridgeService,
  CircleClient,
  CircleTransferService,
  DexService,
  SolanaService,
];

@Module({
  providers: ADAPTER_SERVICES,
  exports: ADAPTER_SERVICES,
})
export class AdaptersModule {}
