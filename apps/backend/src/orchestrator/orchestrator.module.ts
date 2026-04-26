import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { TaskModule } from '../task/task.module';
import { TaskController } from './task.controller';
import { OrchestratorService } from './orchestrator.service';

@Module({
  imports: [TaskModule, QueueModule],
  controllers: [TaskController],
  providers: [OrchestratorService],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}