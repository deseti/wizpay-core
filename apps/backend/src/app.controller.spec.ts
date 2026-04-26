import { Test, TestingModule } from '@nestjs/testing';
import { TaskController } from './orchestrator/task.controller';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { TaskService } from './task/task.service';
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
  };

  const orchestratorService = {
    handleTask: jest.fn().mockResolvedValue(taskFixture),
  };

  const taskService = {
    getTaskById: jest.fn().mockResolvedValue(taskFixture),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        {
          provide: OrchestratorService,
          useValue: orchestratorService,
        },
        {
          provide: TaskService,
          useValue: taskService,
        },
      ],
    }).compile();

    controller = module.get<TaskController>(TaskController);
    jest.clearAllMocks();
  });

  it('creates tasks via the orchestrator', async () => {
    const payload = { batchId: 'payroll-1' };

    await expect(
      controller.createTask({
        type: TaskType.PAYROLL,
        payload,
      }),
    ).resolves.toEqual(taskFixture);

    expect(orchestratorService.handleTask).toHaveBeenCalledWith(
      TaskType.PAYROLL,
      payload,
    );
  });

  it('fetches tasks through the task service', async () => {
    await expect(controller.getTask(taskFixture.id)).resolves.toEqual(taskFixture);
    expect(taskService.getTaskById).toHaveBeenCalledWith(taskFixture.id);
  });
});
