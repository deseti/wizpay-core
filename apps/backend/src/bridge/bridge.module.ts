import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BridgeController } from './bridge.controller';
import { BridgeLifecycleService } from './bridge-lifecycle.service';

@Module({
  imports: [DatabaseModule],
  controllers: [BridgeController],
  providers: [BridgeLifecycleService],
  exports: [BridgeLifecycleService],
})
export class BridgeModule {}
