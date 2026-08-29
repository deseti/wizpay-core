import { HttpException } from '@nestjs/common';
import { W3sAuthController } from './w3s-auth.controller';
import { W3sAuthService } from './w3s-auth.service';

describe('W3sAuthController', () => {
  it('preserves a safe Circle status and code instead of returning an opaque 500', async () => {
    const upstreamError = Object.assign(new Error('Circle request rejected'), {
      code: 155201,
      details: {
        bodyKeys: ['walletId', 'amounts'],
        circleStatus: 422,
        lifecycleStage: 'circle_transfer_creation',
      },
      status: 422,
    });
    const service = {
      dispatch: jest.fn().mockRejectedValue(upstreamError),
    } as unknown as W3sAuthService;
    const controller = new W3sAuthController(service);

    let thrown: HttpException | null = null;
    try {
      await controller.dispatchAction({
        action: 'createTransferChallenge',
        userToken: 'not-logged',
      });
    } catch (error) {
      thrown = error as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown?.getStatus()).toBe(422);
    expect(thrown?.getResponse()).toMatchObject({
      code: 155201,
      error: 'Circle request rejected',
      details: {
        circleStatus: 422,
        lifecycleStage: 'circle_transfer_creation',
      },
    });
  });
});
