import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TaskService } from './task.service';

@Module({
  imports: [DatabaseModule],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}