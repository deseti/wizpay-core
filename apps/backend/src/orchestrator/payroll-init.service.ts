import { Injectable, Logger } from '@nestjs/common';
import { CreatePayrollTaskResult } from '../task/task.types';
import { TaskService } from '../task/task.service';

// ─── Service ────────────────────────────────────────────────────────

/**
 * PayrollInitService orchestrates payroll task preparation.
 *
 * For External Wallet payroll:
 *   The frontend handles cross-currency settlement before calling this endpoint.
 *   By the time this is called, all recipients are same-token relative to sourceToken.
 *   The frontend executes the official Circle adapter swap first, then calls
 *   /tasks/payroll/init with sourceToken = targetToken.
 *
 * This service simply delegates to TaskService.createPayrollTask().
 */
@Injectable()
export class PayrollInitService {
  private readonly logger = new Logger(PayrollInitService.name);

  constructor(private readonly taskService: TaskService) {}

  async prepare(payload: Record<string, unknown>): Promise<CreatePayrollTaskResult> {
    return this.taskService.createPayrollTask(payload);
  }
}
