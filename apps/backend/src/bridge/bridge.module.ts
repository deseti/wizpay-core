import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BridgeController } from './bridge.controller';
import { BridgeLifecycleService } from './bridge-lifecycle.service';
import { BridgeQuoteService } from './bridge-quote.service';

@Module({
  imports: [DatabaseModule],
  controllers: [BridgeController],
  providers: [BridgeLifecycleService, BridgeQuoteService],
  exports: [BridgeLifecycleService, BridgeQuoteService],
})
export class BridgeModule {}
