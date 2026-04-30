import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { AdaptersModule } from '../adapters/adapters.module';

@Module({
  imports: [AdaptersModule],
  controllers: [TreasuryController],
  providers: [TreasuryService],
  exports: [TreasuryService]
})
export class TreasuryModule {}
