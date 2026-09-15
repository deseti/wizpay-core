import { ServiceUnavailableException } from '@nestjs/common';
import { TaskController } from './task.controller';

describe('TaskController Mainnet liquidity boundary', () => {
  it('rejects before task creation when liquidity capability is disabled', async () => {
    const createLiquidityTask = jest.fn();
    const assert = jest.fn(() => {
      throw new ServiceUnavailableException({ code: 'CAPABILITY_DISABLED' });
    });
    const controller = Reflect.construct(TaskController, [
      { createLiquidityTask },
      {},
      {},
      {},
      {},
      { assert },
      {},
      {},
    ]) as TaskController;

    await expect(controller.initLiquidity({ operation: 'add' })).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(assert).toHaveBeenCalledWith('liquidity');
    expect(createLiquidityTask).not.toHaveBeenCalled();
  });
});
