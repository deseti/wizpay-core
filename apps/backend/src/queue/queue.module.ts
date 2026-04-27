import { forwardRef, Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TaskModule } from '../task/task.module';
import { PayrollProcessor } from './processors/payroll.processor';
import { TransactionPollerService } from './processors/transaction-poller.service';
import { TxPollProcessor } from './processors/tx-poll.processor';
import { QueueService } from './queue.service';
import { PayrollWorker } from './workers/payroll.worker';
import { TxPollWorker } from './workers/tx-poll.worker';

@Module({
  imports: [
    TaskModule,
    IntegrationsModule,
    AdaptersModule,
    // forwardRef breaks the circular dependency:
    //   QueueModule  → OrchestratorModule → QueueModule
    forwardRef(() => OrchestratorModule),
  ],
  providers: [
    QueueService,
    PayrollProcessor,
    PayrollWorker,
    TransactionPollerService,
    TxPollProcessor,
    TxPollWorker,
  ],
  exports: [QueueService],
})
export class QueueModule {}