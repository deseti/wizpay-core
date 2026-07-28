import { Injectable, Logger, Optional } from '@nestjs/common';
import { PayrollFxPayoutPlanService } from '../payroll-fx/payroll-fx-payout-plan.service';
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

  constructor(
    private readonly taskService: TaskService,
    @Optional()
    private readonly payrollFxPayoutPlans?: PayrollFxPayoutPlanService,
  ) {}

  async prepare(
    payload: Record<string, unknown>,
  ): Promise<CreatePayrollTaskResult> {
    const task = await this.taskService.createPayrollTask(payload);
    await this.payrollFxPayoutPlans?.createForTaskIfEligible(task.taskId);
    return task;
  }
}
