import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Socket } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../app.module';
import { createWizPayApplication } from '../application';
import { PrismaService } from '../database/prisma.service';
import { TaskService } from '../task/task.service';
import { ExecutionIntentService } from '../execution-intent/execution-intent.service';
import { MainnetUniswapV4Service } from '../user-swap/mainnet-uniswap-v4.service';
import { BridgeLifecycleService } from '../bridge/bridge-lifecycle.service';
import { ActivityService } from '../activity/activity.service';
import { createServerlessHandler } from '../serverless';

// Any import edge reaching legacy transports fails immediately, before a network retry.
jest.mock('bullmq', () => {
  throw new Error('BullMQ must not load in serverless HTTP composition.');
});
jest.mock('ioredis', () => {
  throw new Error('ioredis must not load in serverless HTTP composition.');
});

describe('Redis-free serverless HTTP composition', () => {
  const originalEnvironment = { ...process.env };
  const database = {
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    walletAuthChallenge: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'test-challenge', ...data }),
      ),
    },
  };
  let app: INestApplication;
  let handler: ReturnType<typeof createServerlessHandler>;

  beforeAll(async () => {
    process.env = {
      NODE_ENV: 'test',
      WIZPAY_ARC_NETWORK: 'arc-mainnet',
      ARC_MAINNET_DATABASE_URL:
        'postgresql://test:test@127.0.0.1:15432/wizpay_arc_mainnet',
    };
    const connect = jest
      .spyOn(Socket.prototype, 'connect')
      .mockImplementation(() => {
        throw new Error('TCP is unavailable during serverless initialization.');
      });
    try {
      app = await createWizPayApplication({
        runtimeMode: 'serverless',
        createApplication: async (mode) => {
          const module = await Test.createTestingModule({
            imports: [AppModule.forRuntime(mode)],
          })
            .overrideProvider(PrismaService)
            .useValue(database)
            .compile();
          return module.createNestApplication();
        },
      });
      await app.init();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
    handler = createServerlessHandler(() => Promise.resolve(app));
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnvironment;
  });

  it('serves health and diagnostics with Redis unavailable and no Redis configuration', async () => {
    await request(handler).get('/health').expect(200).expect({ status: 'ok' });
    const response = await request(handler)
      .get('/health/runtime-isolation')
      .expect(200);
    expect(response.body).not.toHaveProperty('redis');
    expect(response.body).not.toHaveProperty('queuePrefix');
    expect(app.get(ConfigService).get('REDIS_URL')).toBeUndefined();
    expect(app.get(ConfigService).get('BULLMQ_PREFIX')).toBeUndefined();
  });

  it('excludes legacy producers, consumers, processors and orchestration rather than supplying a no-op queue', () => {
    const modules = [...app.get(ModulesContainer).values()];
    const moduleNames = modules.map((module) => module.metatype.name);
    expect(moduleNames).not.toContain('QueueModule');
    expect(moduleNames).not.toContain('OrchestratorModule');
    const providers = modules.flatMap((module) =>
      [...module.providers.values()].map((provider) => String(provider.name)),
    );
    for (const name of [
      'QueueService',
      'PayrollWorker',
      'SwapWorker',
      'TxPollWorker',
      'TransactionPollerService',
      'OrchestratorService',
    ]) {
      expect(providers).not.toContain(name);
    }
  });

  it('initializes request-critical payment, verification, bridge and activity services without queue transports', () => {
    for (const service of [
      TaskService,
      ExecutionIntentService,
      MainnetUniswapV4Service,
      BridgeLifecycleService,
      ActivityService,
    ]) {
      expect(app.get(service)).toBeDefined();
    }
  });

  it('persists an external-wallet authentication challenge without signing or queueing', async () => {
    const response = await request(handler)
      .post('/wallets/auth/challenge')
      .send({
        address: '0x1000000000000000000000000000000000000001',
        chainId: 5042,
      })
      .expect(201);
    const body = response.body as {
      data: { challengeId: string; message: string };
    };
    expect(body.data.challengeId).toBe('test-challenge');
    expect(body.data.message).toContain(
      'Sign this message to prove control of your wallet',
    );
    expect(database.walletAuthChallenge.create).toHaveBeenCalledTimes(1);
    expect(body.data).not.toHaveProperty('privateKey');
  });

  it('preserves task, swap, bridge and intent request validation and account authorization', async () => {
    await request(handler).post('/tasks/payroll/init').send({}).expect(400);
    await request(handler)
      .post('/user-swap/mainnet/quote')
      .send({})
      .expect(400);
    await request(handler).post('/bridge/intents').send({}).expect(400);
    await request(handler)
      .post('/execution-intents/acquire')
      .send({})
      .expect(400);
    await request(handler).get('/tasks').expect(401);
    await request(handler).get('/activities').expect(401);
  });

  it('reuses application-scoped Prisma across warm requests without connecting or disconnecting per request', async () => {
    await Promise.all([
      request(handler).get('/health').expect(200),
      request(handler).get('/health').expect(200),
    ]);
    expect(app.get(PrismaService)).toBe(database);
    expect(database.onModuleInit).toHaveBeenCalledTimes(1);
    expect(database.onModuleDestroy).not.toHaveBeenCalled();
    expect((app.getHttpServer() as Server).listening).toBe(false);
  });
});
