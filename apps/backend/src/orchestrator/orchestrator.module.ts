import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { OrchestratorService } from './orchestrator.service';
import { TaskController } from './task.controller';

@Module({
  imports: [TaskModule, QueueModule, AgentsModule],
  controllers: [TaskController],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}