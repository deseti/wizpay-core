/* eslint-disable @typescript-eslint/require-await */
import { UnauthorizedException } from '@nestjs/common';
import { ActivityController } from './activity.controller';

describe('ActivityController authentication', () => {
  it('uses only the database-backed read authenticator for GET', async () => {
    const auth = {
      authenticateCirclePrincipal: jest.fn(),
    };
    const activity = {
      authenticateRead: jest.fn(async () => {
        throw new UnauthorizedException();
      }),
      sync: jest.fn(),
      list: jest.fn(),
      validateListInput: jest.fn(),
    };
    const controller = new ActivityController(auth as never, activity as never);
    await expect(controller.list(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(auth.authenticateCirclePrincipal).not.toHaveBeenCalled();
    expect(activity.sync).not.toHaveBeenCalled();
    expect(activity.list).not.toHaveBeenCalled();
  });

  it('ignores client ownership identifiers because the endpoint accepts no user or wallet authority', async () => {
    const principal = {
      merchantUserId: 'user-a',
      merchantWalletAddress: '0x1111111111111111111111111111111111111111',
    };
    const auth = {
      authenticateCirclePrincipal: jest.fn(),
    };
    const activity = {
      authenticateRead: jest.fn(async () => principal),
      sync: jest.fn(),
      validateListInput: jest.fn(),
      list: jest.fn(async () => ({ items: [], nextCursor: null })),
    };
    const controller = new ActivityController(auth as never, activity as never);
    await controller.list(
      'Bearer valid',
      undefined,
      '20',
      undefined,
      undefined,
    );
    expect(activity.list).toHaveBeenCalledWith(principal, {
      cursor: undefined,
      limit: 20,
      type: undefined,
      status: undefined,
    });
    expect(auth.authenticateCirclePrincipal).not.toHaveBeenCalled();
  });

  it('uses canonical Circle authentication only for explicit sync', async () => {
    const principal = {
      merchantUserId: 'user-a',
      merchantWalletAddress: '0x1111111111111111111111111111111111111111',
      circleWalletId: 'wallet-a',
      userToken: 'token-a',
    };
    const auth = {
      authenticateCirclePrincipal: jest.fn(async () => principal),
    };
    const summary = {
      source: 'circle_w3s',
      status: 'synced',
      pagesScanned: 1,
      recordsScanned: 0,
      recordsAccepted: 0,
      checkpointAdvanced: false,
      retryAfterMs: 60_000,
      readSessionToken: 'opaque-read-session-token',
    };
    const activity = {
      authenticateRead: jest.fn(),
      sync: jest.fn(async () => summary),
    };
    const controller = new ActivityController(auth as never, activity as never);
    await expect(controller.sync('Bearer valid')).resolves.toEqual({
      data: summary,
    });
    expect(auth.authenticateCirclePrincipal).toHaveBeenCalledWith(
      'Bearer valid',
    );
    expect(activity.sync).toHaveBeenCalledWith(principal);
  });
});
