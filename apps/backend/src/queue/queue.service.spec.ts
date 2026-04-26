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

  const configService = {
    get: jest.fn(),
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
      `${TaskType.PAYROLL}:${jobData.taskId}`,
      jobData,
      expect.objectContaining({
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
});