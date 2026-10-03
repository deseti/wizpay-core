import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TaskModule } from '../task/task.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { BridgeModule } from '../bridge/bridge.module';
import { PostgresDeliveryModule } from './postgres-delivery.module';
import { RecoveryVerifierService } from './recovery-verifier.service';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [
    DatabaseModule,
    TaskModule,
    InvoiceModule,
    UserSwapModule,
    BridgeModule,
    PostgresDeliveryModule,
  ],
  providers: [RecoveryVerifierService, ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
