import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

type NestHttpExceptionShape = {
  getResponse: () => unknown;
  getStatus: () => number;
};

export type MappedHttpException = Readonly<{
  body: unknown;
  status: number;
}>;

function isNestHttpException(error: unknown): error is NestHttpExceptionShape {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    getResponse?: unknown;
    getStatus?: unknown;
  };
  return (
    typeof candidate.getStatus === 'function' &&
    typeof candidate.getResponse === 'function'
  );
}

function jsonBody(status: number, body: unknown) {
  if (typeof body === 'object' && body !== null) return body;
  return { statusCode: status, message: body };
}

export function mapHttpException(error: unknown): MappedHttpException {
  if (error instanceof HttpException || isNestHttpException(error)) {
    const status = error.getStatus();
    return { status, body: jsonBody(status, error.getResponse()) };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: error instanceof Error ? error.message : 'Internal server error',
    },
  };
}

/**
 * Maps Nest HTTP exceptions even when duplicate @nestjs/common copies
 * break `instanceof HttpException` across the workspace graph.
 */
@Catch()
export class HttpExceptionCompatibilityFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const mapped = mapHttpException(error);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(mapped.status)
      .json(mapped.body);
  }
}
