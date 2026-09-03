/* eslint-disable @typescript-eslint/require-await */
import { ActivityBackfillService } from './activity-backfill.service';

describe('ActivityBackfillService', () => {
  it('skips malformed and ambiguous canonical wallets and is restart-safe through projection upserts', async () => {
    const wallets = [
      {
        id: '1',
        userId: 'a',
        walletId: 'wa',
        address: '0x1111111111111111111111111111111111111111',
      },
      {
        id: '2',
        userId: 'b',
        walletId: 'wb',
        address: '0x2222222222222222222222222222222222222222',
      },
      {
        id: '3',
        userId: 'c',
        walletId: 'wc',
        address: '0x2222222222222222222222222222222222222222',
      },
      { id: '4', userId: 'd', walletId: 'wd', address: 'malformed' },
    ];
    const activity = { projectPersisted: jest.fn(async () => undefined) };
    const service = new ActivityBackfillService(
      { userWallet: { findMany: jest.fn(async () => wallets) } } as never,
      activity as never,
    );
    const report = await service.run();
    expect(activity.projectPersisted).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      canonicalWalletsScanned: 4,
      ownersProjected: 1,
      malformedWalletsSkipped: 1,
      ambiguousWalletsSkipped: 2,
    });
    expect(report.unsupportedCategories).toContain(
      'ownerless_or_recipient_only_task',
    );
  });
});
