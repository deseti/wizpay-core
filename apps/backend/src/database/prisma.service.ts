import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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
    const connectionString = configService.getOrThrow<string>('DATABASE_URL');

    const adapter = new PrismaPg({ connectionString });

    super({
      adapter,
      log: ['error', 'warn'],
    });

    const diagnostic = configService.get<{
      database: { host: string; port: number; database: string };
      environment: string;
    }>('RUNTIME_ISOLATION_DIAGNOSTIC');
    if (diagnostic) {
      this.logger.log(
        `Database target: host=${diagnostic.database.host} port=${diagnostic.database.port} database=${diagnostic.database.database}`,
      );
      this.logger.log(`Environment: ${diagnostic.environment}`);
    }
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
