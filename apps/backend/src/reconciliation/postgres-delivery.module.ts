import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PostgresDeliveryService } from './postgres-delivery.service';

@Module({
  imports: [DatabaseModule],
  providers: [PostgresDeliveryService],
  exports: [PostgresDeliveryService],
})
export class PostgresDeliveryModule {}
