import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { WalletModule } from '../modules/wallet/wallet.module';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityBackfillService } from './activity-backfill.service';

@Module({
  imports: [DatabaseModule, InvoiceModule, WalletModule],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityBackfillService],
  exports: [ActivityService, ActivityBackfillService],
})
export class ActivityModule {}
