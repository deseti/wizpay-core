import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import { DexService } from './dex.service';
import { SolanaService } from './solana.service';

const ADAPTER_SERVICES = [BlockchainService, DexService, SolanaService];

@Module({
  providers: ADAPTER_SERVICES,
  exports: ADAPTER_SERVICES,
})
export class AdaptersModule {}
