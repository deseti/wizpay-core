import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ConfigService } from '@nestjs/config';
import type { RuntimeIsolationDiagnostic } from './config/runtime-isolation.config';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/runtime-isolation')
  getRuntimeIsolation(): RuntimeIsolationDiagnostic {
    return this.config.getOrThrow<RuntimeIsolationDiagnostic>(
      'RUNTIME_ISOLATION_DIAGNOSTIC',
    );
  }
}
