import { Test, TestingModule } from '@nestjs/testing';
import { OrchestratorService } from './orchestrator.service';
import { TaskService } from '../task/task.service';
import { QueueService } from '../queue/queue.service';
import { ExecutionRouterService } from '../execution/execution-router.service';
import { CapabilityService } from '../capabilities/capability.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';

describe('OrchestratorService (Arc Mainnet)', () => {
  let service: OrchestratorService;
  let taskService: jest.Mocked<TaskService>;
  let queueService: jest.Mocked<QueueService>;
  let executionRouter: jest.Mocked<ExecutionRouterService>;

  const mockTaskDetails = {
    id: 'task-123',
    type: TaskType.PAYROLL,
    status: TaskStatus.ASSIGNED,
    totalUnits: 0,
    completedUnits: 0,
    failedUnits: 0,
    metadata: null,
    payload: {},
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    logs: [],
    units: [],
    transactions: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrchestratorService,
        {
          provide: TaskService,
          useValue: {
            createTask: jest.fn().mockResolvedValue(mockTaskDetails),
            getTaskById: jest.fn().mockResolvedValue(mockTaskDetails),
            updateStatus: jest.fn().mockResolvedValue(undefined),
            logStep: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: QueueService,
          useValue: {
            enqueueTask: jest.fn().mockResolvedValue(undefined),
            enqueueTransactionPoll: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ExecutionRouterService,
          useValue: {
            execute: jest.fn().mockResolvedValue({ agent: 'payroll' }),
          },
        },
        {
          provide: CapabilityService,
          useValue: { assert: jest.fn(), assertPayroll: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(OrchestratorService);
    taskService = module.get(TaskService) as jest.Mocked<TaskService>;
    queueService = module.get(QueueService) as jest.Mocked<QueueService>;
    executionRouter = module.get(
      ExecutionRouterService,
    ) as jest.Mocked<ExecutionRouterService>;
  });

  describe('handleTask()', () => {
    it('enqueues payroll tasks after capability checks', async () => {
      const payload = { sourceToken: 'USDC', recipients: [] };

      const result = await service.handleTask(TaskType.PAYROLL, payload);

      expect(result).toEqual(mockTaskDetails);
      expect(taskService.createTask).toHaveBeenCalledWith(
        TaskType.PAYROLL,
        payload,
      );
      expect(queueService.enqueueTask).toHaveBeenCalled();
    });

    it('retires FX tasks before any side effect', async () => {
      await expect(
        service.handleTask(TaskType.FX, {
          sourceToken: 'USDC',
          destinationToken: 'EURC',
          amount: '1000',
          minOutput: '900',
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
        }),
      ).rejects.toMatchObject({
        response: { code: 'FX_TASK_TYPE_RETIRED' },
      });

      expect(taskService.createTask).not.toHaveBeenCalled();
      expect(queueService.enqueueTask).not.toHaveBeenCalled();
    });

    it('removes bridge tasks before any side effect', async () => {
      await expect(service.handleTask(TaskType.BRIDGE, {})).rejects.toThrow(
        'Legacy bridge tasks were removed.',
      );

      expect(taskService.createTask).not.toHaveBeenCalled();
    });

    it('rejects unsupported task types', async () => {
      await expect(
        service.handleTask('unknown' as TaskType, {}),
      ).rejects.toThrow();
    });
  });

  describe('executeTask()', () => {
    it('skips tasks that are not assigned (idempotency)', async () => {
      taskService.getTaskById.mockResolvedValue({
        ...mockTaskDetails,
        status: TaskStatus.IN_PROGRESS,
      });

      await expect(service.executeTask('task-123')).resolves.toBeNull();
      expect(executionRouter.execute).not.toHaveBeenCalled();
    });

    it('routes assigned tasks through the execution router', async () => {
      taskService.getTaskById.mockResolvedValue({
        ...mockTaskDetails,
        status: 'assigned',
      });

      await service.executeTask('task-123');

      expect(executionRouter.execute).toHaveBeenCalled();
      expect(taskService.updateStatus).toHaveBeenCalledWith(
        'task-123',
        TaskStatus.IN_PROGRESS,
        expect.objectContaining({ step: 'task.in_progress' }),
      );
    });
  });
});
