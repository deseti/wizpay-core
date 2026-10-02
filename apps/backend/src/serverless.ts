import type { INestApplication } from '@nestjs/common';
import type { Application } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createWizPayApplication,
  type ApplicationOptions,
} from './application';

type ApplicationFactory = (
  options: ApplicationOptions,
) => Promise<INestApplication>;

/** One lazy application per handler/module, shared by cold and warm requests. */
export function createServerlessHandler(
  factory: ApplicationFactory = createWizPayApplication,
) {
  let initialization: Promise<Application> | undefined;
  async function initialize(): Promise<Application> {
    const app = await factory({ runtimeMode: 'serverless' });
    try {
      await app.init();
      return app.getHttpAdapter().getInstance() as Application;
    } catch (error) {
      // Release partially initialized resources; never disconnect on warm requests.
      await app.close().catch(() => undefined);
      throw error;
    }
  }
  return async function handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      initialization ??= initialize().catch((error: unknown) => {
        initialization = undefined;
        throw error;
      });
      const express = await initialization;
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
