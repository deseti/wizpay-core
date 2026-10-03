import { Module, forwardRef } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { AgentsModule } from '../agents/agents.module';
import { ExecutionModule } from '../execution/execution.module';
import { FxModule } from '../fx/fx.module';
import { InvoiceModule } from '../invoice/invoice.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { OrchestratorService } from './orchestrator.service';
import { TaskHttpModule } from '../task/task-http.module';

@Module({
  imports: [
    TaskModule,
    TaskHttpModule,
    AdaptersModule,
    FxModule,
    InvoiceModule,
    UserSwapModule,
    forwardRef(() => QueueModule),
    forwardRef(() => AgentsModule),
    ExecutionModule,
  ],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
