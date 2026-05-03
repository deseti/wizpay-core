import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // ── CORS ─────────────────────────────────────────────────────────────
  // Read allowed origins from CORS_ORIGINS env var (comma-separated).
  // Falls back to localhost:3000 and localhost:3001 for local development.
  // Example: CORS_ORIGINS=https://wizpay.example.com,http://localhost:3000
  const corsOrigins = (
    process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  logger.log(`Application running on port ${port}`);
  logger.log(`CORS origins: ${corsOrigins.join(', ')}`);
}
bootstrap();
