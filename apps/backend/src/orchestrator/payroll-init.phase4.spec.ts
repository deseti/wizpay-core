import type { PayrollFxPayoutPlanService } from '../payroll-fx/payroll-fx-payout-plan.service';
import type { TaskService } from '../task/task.service';
import type { CreatePayrollTaskResult } from '../task/task.types';
import { PayrollInitService } from './payroll-init.service';

describe('PayrollInitService Phase 4 orchestration', () => {
  const result: CreatePayrollTaskResult = {
    taskId: '2bb240b0-8335-4f26-9e70-49c9d2115cf3',
    approvalAmount: '0',
    referenceId: 'run-1',
    totalUnits: 1,
    units: [],
  };
  const createPayrollTask = jest.fn(() => Promise.resolve(result));
  const createForTaskIfEligible = jest.fn(() => Promise.resolve(null));
  const taskService = {
    createPayrollTask,
  } as unknown as TaskService;
  const payoutPlans = {
    createForTaskIfEligible,
  } as unknown as PayrollFxPayoutPlanService;
  const service = new PayrollInitService(taskService, payoutPlans);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('binds and plans internally after task creation without changing the public result', async () => {
    const payload = {
      sourceToken: 'USDC',
      referenceId: 'run-1',
      recipients: [],
    };
    await expect(service.prepare(payload)).resolves.toBe(result);
    expect(createPayrollTask).toHaveBeenCalledWith(payload);
    expect(createForTaskIfEligible).toHaveBeenCalledWith(result.taskId);
  });

  it('preserves direct-token behavior when no eligible FX operation exists', async () => {
    await expect(
      service.prepare({
        sourceToken: 'USDC',
        referenceId: 'direct-1',
        recipients: [
          {
            address: '0x1111111111111111111111111111111111111111',
            amount: '1',
            targetToken: 'USDC',
          },
        ],
      }),
    ).resolves.toBe(result);
    expect(createForTaskIfEligible).toHaveBeenCalledTimes(1);
  });
});
