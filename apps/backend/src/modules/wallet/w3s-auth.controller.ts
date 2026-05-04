import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  InternalServerErrorException,
  Post,
} from '@nestjs/common';
import { W3sAuthService } from './w3s-auth.service';

type W3sActionBody = {
  action?: string;
  [key: string]: unknown;
};

/**
 * Exposes a single POST /w3s/action endpoint that the frontend calls
 * instead of the deleted Next.js /api/w3s proxy route.
 *
 * The frontend sends { action: "createDeviceToken", ...params } and this
 * controller dispatches to the W3sAuthService.
 */
@Controller('w3s')
export class W3sAuthController {
  constructor(private readonly w3sAuthService: W3sAuthService) {}

  @Post('action')
  async dispatchAction(@Body() body: W3sActionBody) {
    const action = typeof body.action === 'string' ? body.action.trim() : '';

    if (!action) {
      throw new BadRequestException('Missing required field: action');
    }

    // Extract params (everything except "action")
    const { action: _removed, ...params } = body;

    try {
      return await this.w3sAuthService.dispatch(action, params);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      const err = error as Error & {
        code?: string | number;
        details?: unknown;
        retryAfterMs?: number | null;
        status?: number;
      };

      const status = err.status ?? 500;
      throw new HttpException(
        {
          error: err.message,
          ...(err.code !== undefined ? { code: err.code } : {}),
          ...(err.retryAfterMs !== undefined
            ? { retryAfterMs: err.retryAfterMs }
            : {}),
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
        status,
      );
    }
  }
}
