import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TaskModule } from '../task/task.module';
import { QueueService } from './queue.service';

@Module({
  imports: [TaskModule, AgentsModule, IntegrationsModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}