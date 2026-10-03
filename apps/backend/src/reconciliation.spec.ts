import type { INestApplication } from '@nestjs/common';
import { runReconciliationBatch } from './reconciliation';
import { getServerlessApplication } from './serverless';
import { ReconciliationService } from './reconciliation/reconciliation.service';

jest.mock('./serverless', () => ({ getServerlessApplication: jest.fn() }));

describe('trusted scheduler entrypoint', () => {
  it('gets the shared lazy application and calls one bounded batch without a listener', async () => {
    const batch = jest.fn().mockResolvedValue({ claimed: 0, acknowledged: 0 });
    const get = jest.fn().mockReturnValue({ runReconciliationBatch: batch });
    const listen = jest.fn();
    jest
      .mocked(getServerlessApplication)
      .mockResolvedValue({ get, listen } as unknown as INestApplication);
    await expect(runReconciliationBatch({ limit: 2 })).resolves.toEqual({
      claimed: 0,
      acknowledged: 0,
    });
    expect(get).toHaveBeenCalledWith(ReconciliationService);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith({ limit: 2 });
    expect(listen).not.toHaveBeenCalled();
  });
});
