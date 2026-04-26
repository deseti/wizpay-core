import { Module } from '@nestjs/common';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';
import { CircleAdapter } from '../adapters/circle/circle.adapter';

@Module({
  controllers: [TreasuryController],
  providers: [TreasuryService, CircleAdapter],
  exports: [TreasuryService]
})
export class TreasuryModule {}
