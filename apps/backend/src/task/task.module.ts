import { Module, forwardRef } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AdaptersModule } from '../adapters/adapters.module';
import { DatabaseModule } from '../database/database.module';
import { TaskService } from './task.service';
import { TaskLogService } from './task-log.service';
import { TaskTransactionService } from './task-transaction.service';
import { TaskMapperService } from './task-mapper.service';
import { TaskUnitService } from './task-unit.service';
import { TaskEmployeeBreakdownService } from './task-employee-breakdown.service';
import { TaskPayrollHistoryService } from './task-payroll-history.service';

const TASK_SERVICES = [
  TaskService,
  TaskLogService,
  TaskTransactionService,
  TaskMapperService,
  TaskUnitService,
  TaskEmployeeBreakdownService,
  TaskPayrollHistoryService,
];

@Module({
  imports: [DatabaseModule, AdaptersModule, forwardRef(() => AgentsModule)],
  providers: TASK_SERVICES,
  exports: TASK_SERVICES,
})
export class TaskModule {}