import { Module } from '@nestjs/common';
import { InvoiceModule } from '../invoice/invoice.module';
import { PayrollInitService } from '../orchestrator/payroll-init.service';
import { TaskController } from '../orchestrator/task.controller';
import { TaskModule } from './task.module';

/** Request-driven task APIs do not depend on the legacy execution queue. */
@Module({
  imports: [TaskModule, InvoiceModule],
  controllers: [TaskController],
  providers: [PayrollInitService],
})
export class TaskHttpModule {}
