import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { TelegramService } from '../integrations/telegram.service';
import { TaskService } from '../task/task.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';
import { QueueName, QueueRoutingDefinition } from './queue.constants';
import { QueueService } from './queue.service';
import { TaskQueueJobData } from './queue.types';

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('QueueService', () => {
  const jobData: TaskQueueJobData = {
    network: 'arc-mainnet',
    taskId: 'c7e01b44-0569-466d-b521-b4302fdd49d0',
    taskType: TaskType.PAYROLL,
    agentKey: TaskType.PAYROLL,
    payload: {
      recipients: [{ to: '0xabc', amount: 100, currency: 'USDC' }],
    },
  };

  const route: QueueRoutingDefinition = {
    queueName: QueueName.PAYROLL,
    agentKey: TaskType.PAYROLL,
  };

  const runtimeConfig: Record<string, string> = {
    'arcNetwork.key': 'arc-mainnet',
    BULLMQ_PREFIX: 'wizpay:arc-mainnet',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '6379',
    REDIS_DB: '1',
    REDIS_TLS: 'false',
  };
  const configService = {
    get: jest.fn((key: string) => runtimeConfig[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = runtimeConfig[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;

  const taskService = {
    logStep: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<TaskService, 'logStep'>>;

  const telegramService = {
    notifyTaskUpdate: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<TelegramService, 'notifyTaskUpdate'>>;

  let queueService: QueueService;

  beforeEach(() => {
    jest.clearAllMocks();
    queueService = new QueueService(
      configService,
      taskService as unknown as TaskService,
      telegramService as unknown as TelegramService,
      { assert: jest.fn(), assertPayroll: jest.fn() } as never,
    );
  });

  it('enqueues a job with attempts=3 and exponential backoff', async () => {
    await queueService.enqueueTask(route, jobData);

    // The mocked Queue instance's add() should have been called once
    const MockQueue = Queue as jest.MockedClass<typeof Queue>;
    const mockQueueInstance = MockQueue.mock.results[0].value as {
      add: jest.Mock;
    };

    expect(mockQueueInstance.add).toHaveBeenCalledWith(
      `arc-mainnet:${TaskType.PAYROLL}:${jobData.taskId}`,
      jobData,
      expect.objectContaining({
        jobId: `arc-mainnet--${TaskType.PAYROLL}--${jobData.taskId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      }),
    );
  });

  it('logs a queue.enqueued step after enqueue', async () => {
    await queueService.enqueueTask(route, jobData);

    expect(taskService.logStep).toHaveBeenCalledWith(
      jobData.taskId,
      'queue.enqueued',
      TaskStatus.ASSIGNED,
      expect.stringContaining(QueueName.PAYROLL),
    );
  });

  it('sends a telegram notification after enqueue', async () => {
    await queueService.enqueueTask(route, jobData);

    expect(telegramService.notifyTaskUpdate).toHaveBeenCalledWith(
      jobData.taskId,
      TaskStatus.ASSIGNED,
      expect.stringContaining(QueueName.PAYROLL),
    );
  });

  it('reuses the same Queue instance for the same queue name', async () => {
    await queueService.enqueueTask(route, jobData);
    await queueService.enqueueTask(route, jobData);

    const MockQueue = Queue as jest.MockedClass<typeof Queue>;
    // Queue constructor should have been called only once
    expect(MockQueue).toHaveBeenCalledTimes(1);
  });

  it('rejects a disabled task before creating a queue or recording side effects', async () => {
    queueService = new QueueService(
      configService,
      taskService as unknown as TaskService,
      telegramService as unknown as TelegramService,
      {
        assert: jest.fn(),
        assertPayroll: jest.fn(() => {
          throw new Error('CAPABILITY_DISABLED');
        }),
      } as never,
    );

    await expect(queueService.enqueueTask(route, jobData)).rejects.toThrow(
      'CAPABILITY_DISABLED',
    );
    expect(Queue).not.toHaveBeenCalled();
    expect(taskService.logStep).not.toHaveBeenCalled();
    expect(telegramService.notifyTaskUpdate).not.toHaveBeenCalled();
  });

  it('rejects a Mainnet liquidity job before queue side effects', async () => {
    runtimeConfig['arcNetwork.key'] = 'arc-mainnet';
    const capabilityAssert = jest.fn((capability: unknown) => {
      if (capability === 'liquidity') throw new Error('CAPABILITY_DISABLED');
    });
    queueService = new QueueService(
      configService,
      taskService as unknown as TaskService,
      telegramService as unknown as TelegramService,
      { assert: capabilityAssert, assertPayroll: jest.fn() } as never,
    );

    await expect(
      queueService.enqueueTask(
        { queueName: QueueName.SWAP, agentKey: TaskType.LIQUIDITY },
        {
          ...jobData,
          network: 'arc-mainnet',
          taskType: TaskType.LIQUIDITY,
          agentKey: TaskType.LIQUIDITY,
        },
      ),
    ).rejects.toThrow('CAPABILITY_DISABLED');
    expect(capabilityAssert).toHaveBeenCalledWith('liquidity');
    expect(Queue).not.toHaveBeenCalled();
    runtimeConfig['arcNetwork.key'] = 'arc-mainnet';
  });

  it('rejects a job carrying another network before queue side effects', async () => {
    await expect(
      queueService.enqueueTask(route, {
        ...jobData,
        network: 'arc-legacy' as never,
      }),
    ).rejects.toThrow(
      'Queue job network does not match the selected runtime network.',
    );
    expect(Queue).not.toHaveBeenCalled();
  });

  it('retires FX jobs before queue side effects', async () => {
    await expect(
      queueService.enqueueTask(
        { queueName: QueueName.SWAP, agentKey: TaskType.FX },
        {
          ...jobData,
          taskType: TaskType.FX,
          agentKey: TaskType.FX,
        },
      ),
    ).rejects.toMatchObject({
      response: { code: 'FX_TASK_TYPE_RETIRED' },
    });
    expect(Queue).not.toHaveBeenCalled();
  });

  it('passes the selected network prefix and Redis database to BullMQ', async () => {
    await queueService.enqueueTask(route, jobData);
    expect(Queue).toHaveBeenCalledWith(
      QueueName.PAYROLL,
      expect.objectContaining({
        prefix: 'wizpay:arc-mainnet',
        connection: expect.objectContaining({ db: 1 }),
      }),
    );
  });
});
