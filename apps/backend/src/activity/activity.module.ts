import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityBackfillService } from './activity-backfill.service';

@Module({
  imports: [DatabaseModule, InvoiceModule],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityBackfillService],
  exports: [ActivityService, ActivityBackfillService],
})
export class ActivityModule {}
