import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TaskController } from './orchestrator/task.controller';
import { TaskService } from './task/task.service';
import { TaskEmployeeBreakdownService } from './task/task-employee-breakdown.service';
import { TaskPayrollHistoryService } from './task/task-payroll-history.service';
import { PayrollInitService } from './orchestrator/payroll-init.service';
import { TaskStatus } from './task/task-status.enum';
import { TaskType } from './task/task-type.enum';
import { TaskDetails } from './task/task.types';
import { InvoiceAuthService } from './invoice/invoice-auth.service';

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
    getOwnedTaskById: jest.fn().mockResolvedValue(taskFixture),
    getTaskList: jest.fn(),
    createLiquidityTask: jest.fn(),
  };

  const invoiceAuthService = {
    authenticate: jest.fn(),
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
        {
          provide: InvoiceAuthService,
          useValue: invoiceAuthService,
        },
      ],
    }).compile();

    controller = module.get<TaskController>(TaskController);
    jest.clearAllMocks();
    invoiceAuthService.authenticate.mockResolvedValue({
      merchantWalletAddress: '0x56DE876C902AdA72CF8E7595715127cEA27d43E6',
    });
    taskService.getOwnedTaskById.mockResolvedValue(taskFixture);
  });

  it('keeps current payroll planning on the dedicated init route', async () => {
    const payload = { batchId: 'payroll-1' };

    await expect(controller.initPayroll(payload)).resolves.toEqual({
      data: {},
    });
    expect(payrollInitService.prepare).toHaveBeenCalledWith(payload);
  });

  it('fetches tasks through the task service', async () => {
    await expect(
      controller.getTask(taskFixture.id, 'Bearer user-a'),
    ).resolves.toEqual({
      data: taskFixture,
    });
    expect(taskService.getOwnedTaskById).toHaveBeenCalledWith(
      taskFixture.id,
      '0x56DE876C902AdA72CF8E7595715127cEA27d43E6',
    );
  });

  describe('authenticated task history', () => {
    const walletA = '0x56DE876C902AdA72CF8E7595715127cEA27d43E6';
    const walletB = '0x1111111111111111111111111111111111111111';
    const taskA = {
      ...taskFixture,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const taskB = {
      ...taskFixture,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };

    beforeEach(() => {
      invoiceAuthService.authenticate.mockImplementation(
        (authorization?: string) => {
          if (authorization === 'Bearer user-a') {
            return { merchantWalletAddress: walletA };
          }
          if (authorization === 'Bearer user-b') {
            return { merchantWalletAddress: walletB };
          }
          throw new UnauthorizedException('Invalid Circle session.');
        },
      );
      taskService.getTaskList.mockImplementation(
        ({ walletAddress }: { walletAddress: string }) => {
          const tasks = [
            { owner: walletA.toLowerCase(), task: taskA },
            { owner: walletB.toLowerCase(), task: taskB },
          ].filter(({ owner }) => owner === walletAddress.toLowerCase());
          return { items: tasks.map(({ task }) => task), total: tasks.length };
        },
      );
      taskService.getOwnedTaskById.mockImplementation(
        (id: string, walletAddress: string) => {
          if (
            id === taskA.id &&
            walletAddress.toLowerCase() === walletA.toLowerCase()
          ) {
            return taskA;
          }
          throw new NotFoundException(`Task ${id} not found`);
        },
      );
      taskEmployeeBreakdownService.getPayrollEmployeeBreakdown.mockImplementation(
        (id: string, walletAddress: string) => {
          if (
            id === taskA.id &&
            walletAddress.toLowerCase() === walletA.toLowerCase()
          ) {
            return [];
          }
          throw new NotFoundException(`Task ${id} not found`);
        },
      );
    });

    it('returns existing owned activity without exposing another user task', async () => {
      const response = await controller.listTasks('Bearer user-a');

      expect(response.data.items).toEqual([taskA]);
      expect(response.data.items).not.toContainEqual(taskB);
      expect(taskService.getTaskList).toHaveBeenCalledWith({
        type: undefined,
        status: undefined,
        walletAddress: walletA,
        limit: undefined,
        offset: undefined,
      });
    });

    it('returns an empty list for an authenticated user with no tasks', async () => {
      taskService.getTaskList.mockResolvedValueOnce({ items: [], total: 0 });

      await expect(controller.listTasks('Bearer user-b')).resolves.toEqual({
        data: { items: [], total: 0 },
      });
    });

    it('rejects missing or invalid auth before task history is queried', async () => {
      await expect(controller.listTasks(undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(
        controller.listTasks('Bearer invalid'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(taskService.getTaskList).not.toHaveBeenCalled();
    });

    it('does not let User B read User A task details or employee breakdown by ID', async () => {
      await expect(
        controller.getTask(taskA.id, 'Bearer user-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        controller.getEmployeeBreakdown(taskA.id, 'Bearer user-b'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns User A owned task detail and authorizes its employee breakdown', async () => {
      await expect(
        controller.getTask(taskA.id, 'Bearer user-a'),
      ).resolves.toEqual({ data: taskA });
      await expect(
        controller.getEmployeeBreakdown(taskA.id, 'Bearer user-a'),
      ).resolves.toEqual({ data: [] });
      expect(
        taskEmployeeBreakdownService.getPayrollEmployeeBreakdown,
      ).toHaveBeenCalledWith(taskA.id, walletA);
    });
  });
});
