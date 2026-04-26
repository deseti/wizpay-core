import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    const connectionString =
      process.env.DATABASE_URL ??
      configService.getOrThrow<string>('DATABASE_URL');

    process.env.DATABASE_URL = connectionString;

    const adapter = new PrismaPg({ connectionString });

    super({
      adapter,
      log: ['error', 'warn'],
    });

    // Startup log: masked DATABASE_URL + environment
    const maskedUrl = connectionString.replace(
      /\/\/([^:]+):([^@]+)@/,
      '//$1:****@',
    );
    const isDocker =
      process.env.DOCKER === 'true' ||
      process.env.NODE_ENV === 'production' ||
      connectionString.includes('@postgres:');

    this.logger.log(`DATABASE_URL: ${maskedUrl}`);
    this.logger.log(`Environment: ${isDocker ? 'docker' : 'local'}`);
  }

  async onModuleInit() {
    await this.connectWithRetry();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private async connectWithRetry(attempt = 1): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Database connection established');
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        this.logger.error(
          `Failed to connect to database after ${MAX_RETRIES} attempts`,
        );
        throw error;
      }
      this.logger.warn(
        `Database connection attempt ${attempt}/${MAX_RETRIES} failed. Retrying in ${RETRY_DELAY_MS}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return this.connectWithRetry(attempt + 1);
    }
  }
}