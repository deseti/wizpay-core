import { Test, TestingModule } from '@nestjs/testing';
import { TaskController } from './orchestrator/task.controller';
import { TaskService } from './task/task.service';
import { TaskEmployeeBreakdownService } from './task/task-employee-breakdown.service';
import { TaskPayrollHistoryService } from './task/task-payroll-history.service';
import { PayrollInitService } from './orchestrator/payroll-init.service';
import { TaskStatus } from './task/task-status.enum';
import { TaskType } from './task/task-type.enum';
import { TaskDetails } from './task/task.types';

describe('TaskController', () => {
  let controller: TaskController;

  const taskFixture: TaskDetails = {
    id: '8cc3ee7d-06b1-4b35-a320-f5d94d3c9fe7',
    type: TaskType.PAYROLL,
    status: TaskStatus.ASSIGNED,
    payload: { batchId: 'payroll-1' },
    result: null,
    createdAt: new Date('2026-04-26T00:00:00.000Z'),
    updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    logs: [],
    transactions: [],
  };

  const taskService = {
    getTaskById: jest.fn().mockResolvedValue(taskFixture),
    createLiquidityTask: jest.fn(),
  };

  const taskEmployeeBreakdownService = {
    getPayrollEmployeeBreakdown: jest.fn().mockResolvedValue([]),
  };

  const taskPayrollHistoryService = {
    getWalletPayrollHistory: jest.fn().mockResolvedValue([]),
  };

  const payrollInitService = {
    prepare: jest.fn().mockResolvedValue({}),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        {
          provide: TaskService,
          useValue: taskService,
        },
        {
          provide: TaskEmployeeBreakdownService,
          useValue: taskEmployeeBreakdownService,
        },
        {
          provide: TaskPayrollHistoryService,
          useValue: taskPayrollHistoryService,
        },
        {
          provide: PayrollInitService,
          useValue: payrollInitService,
        },
      ],
    }).compile();

    controller = module.get<TaskController>(TaskController);
    jest.clearAllMocks();
  });

  it('keeps current payroll planning on the dedicated init route', async () => {
    const payload = { batchId: 'payroll-1' };

    await expect(controller.initPayroll(payload)).resolves.toEqual({
      data: {},
    });
    expect(payrollInitService.prepare).toHaveBeenCalledWith(payload);
  });

  it('fetches tasks through the task service', async () => {
    await expect(controller.getTask(taskFixture.id)).resolves.toEqual({
      data: taskFixture,
    });
    expect(taskService.getTaskById).toHaveBeenCalledWith(taskFixture.id);
  });
});
