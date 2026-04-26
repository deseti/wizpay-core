import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AgentRouterService } from '../agents/agent-router.service';
import { PayrollAgent } from '../agents/payroll/payroll.agent';
import { TelegramService } from '../integrations/telegram.service';
import { TaskService } from '../task/task.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails } from '../task/task.types';
import { QueueName } from './queue.constants';
import { QueueService } from './queue.service';
import { TaskQueueJobData } from './queue.types';

describe('QueueService', () => {
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
      ],
    },
    result: null,
    createdAt: new Date('2026-04-26T00:00:00.000Z'),
    updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    logs: [],
  };

  const configService = {
    get: jest.fn(),
  } as unknown as ConfigService;

  const taskService = {
    getTaskById: jest.fn().mockResolvedValue(taskFixture),
    updateStatus: jest.fn(),
    logStep: jest.fn(),
  } as unknown as jest.Mocked<Pick<
    TaskService,
    'getTaskById' | 'updateStatus' | 'logStep'
  >>;

  const agentRouterService = {
    execute: jest.fn(),
  } as unknown as AgentRouterService;

  const payrollAgent = {
    execute: jest.fn().mockResolvedValue({
      agent: 'payroll',
      transfers: [{ txId: 'mock_tx_id' }],
    }),
  } as unknown as jest.Mocked<Pick<PayrollAgent, 'execute'>>;

  const telegramService = {
    notifyTaskUpdate: jest.fn(),
  } as unknown as jest.Mocked<Pick<TelegramService, 'notifyTaskUpdate'>>;

  let queueService: QueueService;

  beforeEach(() => {
    queueService = new QueueService(
      configService,
      taskService as unknown as TaskService,
      agentRouterService,
      payrollAgent as unknown as PayrollAgent,
      telegramService as unknown as TelegramService,
    );
    jest.clearAllMocks();
    taskService.getTaskById.mockResolvedValue(taskFixture);
    payrollAgent.execute.mockResolvedValue({
      agent: 'payroll',
      transfers: [{ txId: 'mock_tx_id' }],
    });
  });

  it('routes payroll jobs to the payroll agent processor', async () => {
    const job = {
      data: {
        taskId: taskFixture.id,
        taskType: TaskType.PAYROLL,
        agentKey: TaskType.PAYROLL,
        payload: taskFixture.payload,
      },
    } as Job<TaskQueueJobData>;

    await expect(
      (queueService as unknown as {
        processJob: (
          queueName: QueueName,
          currentJob: Job<TaskQueueJobData>,
        ) => Promise<unknown>;
      }).processJob(QueueName.PAYROLL, job),
    ).resolves.toEqual({
      agent: 'payroll',
      transfers: [{ txId: 'mock_tx_id' }],
    });

    expect(taskService.getTaskById).toHaveBeenCalledWith(taskFixture.id);
    expect(payrollAgent.execute).toHaveBeenCalledWith(taskFixture);
    expect(telegramService.notifyTaskUpdate).toHaveBeenCalledWith(
      taskFixture.id,
      TaskStatus.EXECUTED,
      'Task execution completed',
    );
  });
});