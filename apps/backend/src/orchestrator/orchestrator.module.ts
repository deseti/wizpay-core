import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { OrchestratorService } from './orchestrator.service';
import { PayrollInitService } from './payroll-init.service';
import { TaskController } from './task.controller';

@Module({
  imports: [
    TaskModule,
    forwardRef(() => QueueModule),
    forwardRef(() => AgentsModule),
  ],
  controllers: [TaskController],
  providers: [OrchestratorService, PayrollInitService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
