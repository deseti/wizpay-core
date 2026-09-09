import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { CircleService } from './circle.service';
import { CircleAdapter } from './circle/circle.adapter';
import { CircleClient } from './circle/circle.client';
import { CircleTransferService } from './circle/circle-transfer.service';
import { CircleReceiptVerifierService } from './circle/circle-receipt-verifier.service';
import { DexService } from './dex.service';
import { SolanaService } from './solana.service';

const ADAPTER_SERVICES = [
  BlockchainService,
  CircleService,
  CircleAdapter,
  CircleClient,
  CircleTransferService,
  CircleReceiptVerifierService,
  DexService,
  SolanaService,
];

@Module({
  providers: ADAPTER_SERVICES,
  exports: ADAPTER_SERVICES,
})
export class AdaptersModule {}
