import { Module, forwardRef } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { AgentsModule } from '../agents/agents.module';
import { ExecutionModule } from '../execution/execution.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { OrchestratorService } from './orchestrator.service';
import { PayrollInitService } from './payroll-init.service';
import { TaskController } from './task.controller';

@Module({
  imports: [
    TaskModule,
    AdaptersModule,
    forwardRef(() => QueueModule),
    forwardRef(() => AgentsModule),
    ExecutionModule,
  ],
  controllers: [TaskController],
  providers: [OrchestratorService, PayrollInitService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
