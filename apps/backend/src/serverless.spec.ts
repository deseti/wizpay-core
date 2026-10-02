import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Body,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import request from 'supertest';
import { createWizPayApplication } from './application';
import { HttpExceptionCompatibilityFilter } from './common/http-exception.compatibility-filter';
import { createServerlessHandler } from './serverless';

@Controller('runtime')
class RuntimeController {
  @Get()
  @Header('X-WizPay-Runtime', 'shared')
  @HttpCode(202)
  get() {
    return { status: 'ready' };
  }

  @Post()
  echo(@Body() body: { value: string }) {
    return body;
  }

  @Get('invalid')
  invalid() {
    throw new BadRequestException({ code: 'INVALID_INPUT' });
  }
}

const environment = {
  WIZPAY_ARC_NETWORK: 'arc-mainnet',
  ARC_MAINNET_DATABASE_URL:
    'postgresql://test:test@127.0.0.1:15432/wizpay_arc_mainnet',
  ARC_MAINNET_REDIS_URL: 'redis://127.0.0.1:6379/1',
  ARC_MAINNET_QUEUE_PREFIX: 'wizpay:arc-mainnet',
};

function responseFixture() {
  return {
    headersSent: false,
    setHeader: jest.fn(),
    end: jest.fn(),
    statusCode: 0,
  };
}

describe('serverless HTTP runtime', () => {
  let app: INestApplication;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [RuntimeController],
      providers: [
        { provide: APP_FILTER, useClass: HttpExceptionCompatibilityFilter },
      ],
    }).compile();
    app = module.createNestApplication();
  });
  afterEach(async () => {
    await app.close();
  });

  it('initializes lazily, shares concurrent cold starts, and reuses warm application state', async () => {
    let complete: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const factory = jest.fn(async () => {
      await gate;
      return app;
    });
    const init = jest.spyOn(app, 'init');
    const listen = jest.spyOn(app, 'listen');
    const close = jest.spyOn(app, 'close');
    const shutdown = jest.spyOn(app, 'enableShutdownHooks');
    const handler = createServerlessHandler(factory);
    expect(factory).not.toHaveBeenCalled();
    const responses = [responseFixture(), responseFixture()];
    const calls = responses.map((response) =>
      handler(
        { method: 'GET', url: '/runtime', headers: {} } as IncomingMessage,
        response as unknown as ServerResponse,
      ),
    );
    expect(factory).toHaveBeenCalledTimes(1);
    complete();
    // Use a stub adapter for this concurrency check; real HTTP behavior is tested below.
    const dispatch = jest.fn();
    jest.spyOn(app.getHttpAdapter(), 'getInstance').mockReturnValue(dispatch);
    await Promise.all(calls);
    await handler(
      {} as IncomingMessage,
      responseFixture() as unknown as ServerResponse,
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ runtimeMode: 'serverless' });
    expect(init).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(listen).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect((app.getHttpServer() as Server).listening).toBe(false);
  });

  it('preserves Nest status, body, headers, JSON parsing, CORS, routing and exception filters', async () => {
    const createApplication = jest.fn().mockResolvedValue(app);
    const handler = createServerlessHandler((options) =>
      createWizPayApplication({ ...options, environment, createApplication }),
    );
    const listen = jest.spyOn(app, 'listen');
    await request(handler)
      .get('/runtime')
      .set('Origin', 'http://localhost:3000')
      .expect(202)
      .expect('X-WizPay-Runtime', 'shared')
      .expect('Access-Control-Allow-Origin', 'http://localhost:3000')
      .expect({ status: 'ready' });
    await request(handler)
      .post('/runtime')
      .send({ value: 'hello' })
      .expect(201)
      .expect({ value: 'hello' });
    await request(handler)
      .get('/runtime/invalid')
      .expect(400)
      .expect({ code: 'INVALID_INPUT' });
    await request(handler).get('/missing').expect(404);
    await request(handler)
      .options('/runtime')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(createApplication).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();
    expect((app.getHttpServer() as Server).listening).toBe(false);
  });

  it('clears a failed construction promise and returns only a generic error', async () => {
    const factory = jest
      .fn()
      .mockRejectedValueOnce(new Error('sensitive connection material'))
      .mockResolvedValue(app);
    const handler = createServerlessHandler(factory);
    const response = await request(handler).get('/runtime').expect(503);
    expect(response.body).toEqual({
      statusCode: 503,
      message: 'Service unavailable',
    });
    expect(response.text).not.toContain('sensitive');
    await request(handler).get('/runtime').expect(202);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('closes partial initialization once and lets all failed cold requests retry later', async () => {
    const failedApp = {
      init: jest.fn().mockRejectedValue(new Error('initialization failed')),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const factory = jest
      .fn()
      .mockResolvedValueOnce(failedApp)
      .mockResolvedValue(app);
    const handler = createServerlessHandler(factory);
    const responses = [responseFixture(), responseFixture()];
    await Promise.all(
      responses.map((response) =>
        handler({} as IncomingMessage, response as unknown as ServerResponse),
      ),
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(failedApp.close).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.statusCode)).toEqual([
      503, 503,
    ]);
    await request(handler).get('/runtime').expect(202);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
