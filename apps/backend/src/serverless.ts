import type { INestApplication } from '@nestjs/common';
import type { Application } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createWizPayApplication,
  type ApplicationOptions,
} from './application';

export type ApplicationFactory = (
  options: ApplicationOptions,
) => Promise<INestApplication>;

/** HTTP and trusted scheduler invocations share one application/Prisma lifecycle. */
export function createServerlessApplicationProvider(
  factory: ApplicationFactory = createWizPayApplication,
) {
  let initialization: Promise<INestApplication> | undefined;
  async function initialize(): Promise<INestApplication> {
    const app = await factory({ runtimeMode: 'serverless' });
    try {
      await app.init();
      return app;
    } catch (error) {
      // Release partially initialized resources; never disconnect on warm requests.
      await app.close().catch(() => undefined);
      throw error;
    }
  }
  return function getApplication(): Promise<INestApplication> {
    initialization ??= initialize().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };
}

export const getServerlessApplication = createServerlessApplicationProvider();

/** One lazy application per handler/module, shared by cold and warm requests. */
export function createServerlessHandler(factory?: ApplicationFactory) {
  const getApplication = factory
    ? createServerlessApplicationProvider(factory)
    : getServerlessApplication;
  return async function handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const app = await getApplication();
      const express = app.getHttpAdapter().getInstance() as Application;
      express(request, response);
    } catch {
      // Bootstrap errors may contain connection material. Return no diagnostics.
      if (!response.headersSent) {
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ statusCode: 503, message: 'Service unavailable' }),
        );
      }
    }
  };
}

export const handler = createServerlessHandler();
export default handler;
