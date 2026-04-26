import { forwardRef, Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TaskModule } from '../task/task.module';
import { PayrollProcessor } from './processors/payroll.processor';
import { QueueService } from './queue.service';
import { PayrollWorker } from './workers/payroll.worker';

@Module({
  imports: [
    TaskModule,
    IntegrationsModule,
    // forwardRef breaks the circular dependency:
    //   QueueModule  → OrchestratorModule → QueueModule
    forwardRef(() => OrchestratorModule),
  ],
  providers: [QueueService, PayrollProcessor, PayrollWorker],
  exports: [QueueService],
})
export class QueueModule {}