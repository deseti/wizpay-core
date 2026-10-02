import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Worker } from 'bullmq';
import { PayrollWorker } from '../queue/workers/payroll.worker';
import { SwapWorker } from '../queue/workers/swap.worker';
import { TxPollWorker } from '../queue/workers/tx-poll.worker';
import { PayrollProcessor } from '../queue/processors/payroll.processor';
import { SwapProcessor } from '../queue/processors/swap.processor';
import { TxPollProcessor } from '../queue/processors/tx-poll.processor';
import { RuntimeModule, type WizPayRuntimeMode } from './runtime.module';

jest.mock('bullmq', () => ({ Worker: jest.fn() }));

describe('process-owned BullMQ lifecycle', () => {
  const close = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(Worker)
      .mockImplementation(
        () => ({ on: jest.fn(), close }) as unknown as Worker,
      );
  });

  it.each(['server', 'serverless'] as const)(
    'retains consumers only in %s mode as appropriate',
    async (mode: WizPayRuntimeMode) => {
      const config: Record<string, string> = {
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6379',
        REDIS_DB: '1',
        BULLMQ_PREFIX: 'wizpay:arc-mainnet',
      };
      const module = await Test.createTestingModule({
        imports: [RuntimeModule.forRoot(mode)],
        providers: [
          PayrollWorker,
          SwapWorker,
          TxPollWorker,
          {
            provide: ConfigService,
            useValue: {
              get: (key: string) => config[key],
              getOrThrow: (key: string) => config[key],
            },
          },
          ...[PayrollProcessor, SwapProcessor, TxPollProcessor].map(
            (provide) => ({ provide, useValue: { process: jest.fn() } }),
          ),
        ],
      }).compile();
      const app = module.createNestApplication();
      const workerCount = mode === 'server' ? 3 : 0;
      await app.init();
      await app.init();
      expect(Worker).toHaveBeenCalledTimes(workerCount);
      if (mode === 'server') {
        expect(jest.mocked(Worker).mock.calls.map(([name]) => name)).toEqual([
          'payroll',
          'swap',
          'tx_poll',
        ]);
        expect(
          jest
            .mocked(Worker)
            .mock.calls.map(([, , options]) => options?.concurrency),
        ).toEqual([5, 3, 10]);
      }
      await app.close();
      expect(close).toHaveBeenCalledTimes(workerCount);
    },
  );
});
