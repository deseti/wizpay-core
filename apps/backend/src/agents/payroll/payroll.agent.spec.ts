import { PayrollAgent } from './payroll.agent';
import { CircleService } from '../../adapters/circle.service';
import { TaskService } from '../../task/task.service';
import { TaskStatus } from '../../task/task-status.enum';
import { TaskType } from '../../task/task-type.enum';
import { TaskDetails } from '../../task/task.types';

describe('PayrollAgent', () => {
  const taskFixture: TaskDetails = {
    id: 'c7e01b44-0569-466d-b521-b4302fdd49d0',
    type: TaskType.PAYROLL,
    status: TaskStatus.ASSIGNED,
    payload: {
      recipients: [
        {
          to: '0xabc',
          amount: 100,
          currency: 'USDC',
        },
        {
          to: '0xdef',
          amount: 50,
          currency: 'USDC',
        },
      ],
    },
    result: null,
    createdAt: new Date('2026-04-26T00:00:00.000Z'),
    updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    logs: [],
  };

  const circleService = {
    transfer: jest.fn(),
  } as unknown as jest.Mocked<CircleService>;

  const taskService = {
    updateStatus: jest.fn(),
    logStep: jest.fn(),
  } as unknown as jest.Mocked<Pick<TaskService, 'updateStatus' | 'logStep'>>;

  let payrollAgent: PayrollAgent;

  beforeEach(() => {
    payrollAgent = new PayrollAgent(
      circleService as unknown as CircleService,
      taskService as unknown as TaskService,
    );
    jest.clearAllMocks();
  });

  it('executes payroll transfers and marks the task as executed', async () => {
    circleService.transfer.mockResolvedValue({ txId: 'mock_tx_id' });

    await expect(payrollAgent.execute(taskFixture)).resolves.toEqual({
      agent: 'payroll',
      transfers: [
        {
          to: '0xabc',
          amount: 100,
          currency: 'USDC',
          txId: 'mock_tx_id',
        },
        {
          to: '0xdef',
          amount: 50,
          currency: 'USDC',
          txId: 'mock_tx_id',
        },
      ],
    });

    expect(taskService.updateStatus).toHaveBeenNthCalledWith(
      1,
      taskFixture.id,
      TaskStatus.IN_PROGRESS,
      {
        step: 'task.in_progress',
        message: 'Payroll execution started',
      },
    );
    expect(circleService.transfer).toHaveBeenCalledTimes(2);
    expect(taskService.logStep).toHaveBeenCalledTimes(2);
    expect(taskService.updateStatus).toHaveBeenNthCalledWith(
      2,
      taskFixture.id,
      TaskStatus.EXECUTED,
      expect.objectContaining({
        step: 'task.executed',
        message: 'Payroll execution completed',
      }),
    );
  });

  it('marks the task as failed when a transfer throws', async () => {
    circleService.transfer.mockRejectedValue(new Error('transfer failed'));

    await expect(payrollAgent.execute(taskFixture)).rejects.toThrow(
      'transfer failed',
    );

    expect(taskService.updateStatus).toHaveBeenNthCalledWith(
      1,
      taskFixture.id,
      TaskStatus.IN_PROGRESS,
      {
        step: 'task.in_progress',
        message: 'Payroll execution started',
      },
    );
    expect(taskService.updateStatus).toHaveBeenNthCalledWith(
      2,
      taskFixture.id,
      TaskStatus.FAILED,
      {
        step: 'task.failed',
        message: 'transfer failed',
      },
    );
  });
});