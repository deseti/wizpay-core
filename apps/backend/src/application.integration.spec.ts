import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { createWizPayApplication } from './application';
import { PrismaService } from './database/prisma.service';
import { createServerlessHandler } from './serverless';

describe('root application serverless composition', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication | undefined;

  afterAll(async () => {
    await app?.close();
    process.env = originalEnvironment;
  });

  it('retains real routes and one database lifecycle without Redis consumers, including after a failed cold start', async () => {
    // ConfigModule reads the environment while its module is imported.
    process.env = {
      NODE_ENV: 'test',
      WIZPAY_ARC_NETWORK: 'arc-mainnet',
      ARC_MAINNET_DATABASE_URL:
        'postgresql://test:test@127.0.0.1:15432/wizpay_arc_mainnet',
      ARC_MAINNET_REDIS_URL: 'redis://127.0.0.1:6379/1',
      ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
    };
    /* eslint-disable @typescript-eslint/no-require-imports -- import after configuring the isolated environment */
    const { AppModule } =
      require('./app.module') as typeof import('./app.module');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const database = {
      onModuleInit: jest
        .fn()
        .mockRejectedValueOnce(new Error('test cold-start failure'))
        .mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };
    const createApplication = jest.fn(async (mode: 'server' | 'serverless') => {
      const module = await Test.createTestingModule({
        imports: [AppModule.forRuntime(mode)],
      })
        .overrideProvider(PrismaService)
        .useValue(database)
        .compile();
      app = module.createNestApplication();
      return app;
    });
    const handler = createServerlessHandler((options) =>
      createWizPayApplication({ ...options, createApplication }),
    );
    await request(handler).get('/health').expect(503);
    await request(handler).get('/health').expect(200).expect({ status: 'ok' });
    await request(handler).get('/health/runtime-isolation').expect(200);
    await request(handler).get('/health').expect(200);
    expect(createApplication).toHaveBeenCalledTimes(2);
    expect(database.onModuleInit).toHaveBeenCalledTimes(2);
    expect(database.onModuleDestroy).toHaveBeenCalledTimes(1);
    expect((app?.getHttpServer() as Server).listening).toBe(false);
    expect(app?.get(ConfigService).get<string>('DATABASE_URL')).toBe(
      process.env.ARC_MAINNET_DATABASE_URL,
    );
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.REDIS_URL).toBeUndefined();
    expect(process.env.BULLMQ_PREFIX).toBeUndefined();
    // Real queue workers would attempt to connect to Redis if the boundary failed.
  });
});
