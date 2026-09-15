import { ServiceUnavailableException } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { TaskStatus } from '../task/task-status.enum';
import { TaskType } from '../task/task-type.enum';

function blockedCapabilities() {
  return {
    network: 'arc-mainnet' as const,
    assert: jest.fn((capability: unknown) => {
      if (capability === 'liquidity') {
        throw new ServiceUnavailableException({ code: 'CAPABILITY_DISABLED' });
      }
    }),
    assertPayroll: jest.fn(),
  };
}

describe('OrchestratorService Mainnet liquidity boundary', () => {
  const persistedLiquidityTask = {
    id: 'liquidity-task',
    type: TaskType.LIQUIDITY,
    status: TaskStatus.ASSIGNED,
    payload: { operation: 'add', token: 'USDC', amount: '1' },
  };

  function setup() {
    const taskService = {
      createTask: jest.fn(),
      getTaskById: jest.fn().mockResolvedValue(persistedLiquidityTask),
      updateStatus: jest.fn(),
      logStep: jest.fn(),
    };
    const queueService = { enqueueTask: jest.fn() };
    const executionRouter = { execute: jest.fn() };
    const service = Reflect.construct(OrchestratorService, [
      taskService,
      queueService,
      executionRouter,
      {},
      {},
      blockedCapabilities(),
    ]) as OrchestratorService;
    return { service, taskService, queueService, executionRouter };
  }

  it('rejects new liquidity work before persistence or enqueue', async () => {
    const { service, taskService, queueService } = setup();

    await expect(
      service.handleTask(TaskType.LIQUIDITY, persistedLiquidityTask.payload),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(queueService.enqueueTask).not.toHaveBeenCalled();
  });

  it('rejects previously persisted liquidity work before status or execution', async () => {
    const { service, taskService, executionRouter } = setup();

    await expect(service.executeTask(persistedLiquidityTask.id)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(taskService.updateStatus).not.toHaveBeenCalled();
    expect(executionRouter.execute).not.toHaveBeenCalled();
  });
});
