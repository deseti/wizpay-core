import {
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import type { WizPayAnalyticsSnapshot } from './analytics.types';

@Controller()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('analytics/wizpay')
  getWizPayAnalytics(): WizPayAnalyticsSnapshot {
    return this.analyticsService.getWizPayAnalytics();
  }

  @Post('internal/analytics/wizpay/update')
  updateWizPayAnalytics(
    @Headers('authorization') authorization?: string,
  ): WizPayAnalyticsSnapshot {
    const token = this.extractBearerToken(authorization);
    const secret = this.analyticsService.getCronSecret();

    if (!token || !secret || token !== secret) {
      throw new UnauthorizedException({
        code: 'ANALYTICS_CRON_UNAUTHORIZED',
        message: 'A valid analytics cron bearer token is required.',
      });
    }

    return this.analyticsService.updateWizPayAnalytics();
  }

  private extractBearerToken(authorization?: string): string | undefined {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1]?.trim();
    return token || undefined;
  }
}
