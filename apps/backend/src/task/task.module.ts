import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { DatabaseModule } from '../database/database.module';
import { TaskService } from './task.service';

@Module({
  imports: [DatabaseModule, forwardRef(() => AgentsModule)],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}