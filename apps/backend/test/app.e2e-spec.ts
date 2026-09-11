import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */

describe('Runtime readiness HTTP boundary (e2e)', () => {
  let app: INestApplication;
  const diagnostic = {
    network: 'arc-mainnet',
    environment: 'mainnet',
    database: { host: 'mainnet-db.internal', port: 5432, database: 'wizpay' },
    redis: { host: 'mainnet-redis.internal', port: 6379, databaseIndex: 3 },
    queuePrefix: 'wizpay:arc-mainnet',
    manifest: 'arc-mainnet-unavailable',
    circle: {
      apiCredentialConfigured: false,
      entitySecretConfigured: false,
      walletSetConfigured: false,
      blockchainAvailable: false,
    },
    transactionalCapabilityAvailable: false,
  } as const;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              if (key !== 'RUNTIME_ISOLATION_DIAGNOSTIC')
                throw new Error(`Unexpected configuration key: ${key}`);
              return diagnostic;
            }),
          },
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the local health response', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('reports fail-closed Mainnet readiness without credential values', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/runtime-isolation')
      .expect(200);
    expect(response.body).toEqual(diagnostic);
    expect(Object.values(response.body.circle)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(JSON.stringify(response.body)).not.toContain('credentialValue');
  });
});
