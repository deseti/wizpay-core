/* eslint-disable @typescript-eslint/require-await */
import { UnauthorizedException } from '@nestjs/common';
import { ActivityController } from './activity.controller';

describe('ActivityController authentication', () => {
  it('uses the wallet ownership session authenticator for GET', async () => {
    const auth = {
      authenticate: jest.fn(async () => {
        throw new UnauthorizedException();
      }),
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
    expect(auth.authenticate).toHaveBeenCalledWith(undefined);
    expect(activity.sync).not.toHaveBeenCalled();
    expect(activity.list).not.toHaveBeenCalled();
  });

  it('ignores client ownership identifiers because the endpoint accepts no user or wallet authority', async () => {
    const principal = {
      merchantUserId: 'user-a',
      merchantWalletAddress: '0x1111111111111111111111111111111111111111',
    };
    const auth = {
      authenticate: jest.fn(async () => principal),
    };
    const activity = {
      authenticateRead: jest.fn(),
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
    expect(auth.authenticate).toHaveBeenCalledWith('Bearer valid');
  });

  it('uses external wallet authentication only for explicit sync', async () => {
    const principal = {
      merchantUserId: 'user-a',
      merchantWalletAddress: '0x1111111111111111111111111111111111111111',
      merchantDisplayLabel: null,
    };
    const auth = {
      authenticate: jest.fn(async () => principal),
    };
    const summary = {
      source: 'external_wallet',
      status: 'synced',
      pagesScanned: 0,
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
    expect(auth.authenticate).toHaveBeenCalledWith('Bearer valid');
    expect(activity.sync).toHaveBeenCalledWith(principal);
  });
});
