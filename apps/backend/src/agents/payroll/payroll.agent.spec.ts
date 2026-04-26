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
    status: TaskStatus.IN_PROGRESS, // orchestrator already advanced to in_progress
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

  it('executes payroll transfers and returns the result', async () => {
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

    // Agent no longer calls updateStatus — status lifecycle is owned by OrchestratorService
    expect(taskService.updateStatus).not.toHaveBeenCalled();

    // Agent logs individual transfer steps only
    expect(circleService.transfer).toHaveBeenCalledTimes(2);
    expect(taskService.logStep).toHaveBeenCalledTimes(2);
    expect(taskService.logStep).toHaveBeenCalledWith(
      taskFixture.id,
      'payroll.transfer',
      TaskStatus.IN_PROGRESS,
      expect.stringContaining('0xabc'),
    );
  });

  it('throws when a transfer fails (orchestrator handles status update)', async () => {
    circleService.transfer.mockRejectedValue(new Error('transfer failed'));

    await expect(payrollAgent.execute(taskFixture)).rejects.toThrow(
      'transfer failed',
    );

    // Agent does NOT update status — that is now OrchestratorService.executeTask()'s job
    expect(taskService.updateStatus).not.toHaveBeenCalled();
  });

  it('throws when recipients are missing', async () => {
    const badTask: TaskDetails = { ...taskFixture, payload: {} };

    await expect(payrollAgent.execute(badTask)).rejects.toThrow(
      'Payroll task payload must include recipients',
    );
  });

  it('throws when a recipient has invalid fields', async () => {
    const badTask: TaskDetails = {
      ...taskFixture,
      payload: { recipients: [{ to: '0xabc', amount: 'not-a-number', currency: 'USDC' }] },
    };

    await expect(payrollAgent.execute(badTask)).rejects.toThrow(
      'Payroll task payload contains an invalid recipient',
    );
  });
});