import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { AdaptersModule } from '../adapters/adapters.module';
import { FxModule } from '../fx/fx.module';

@Module({
  imports: [AdaptersModule, FxModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService]
})
export class TreasuryModule {}
