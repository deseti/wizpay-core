import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_DATABASE_URL } from '../config/configuration';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(configService: ConfigService) {
    const connectionString =
      process.env.DATABASE_URL ??
      configService.get<string>('DATABASE_URL') ??
      DEFAULT_DATABASE_URL;

    process.env.DATABASE_URL = connectionString;

    const adapter = new PrismaPg({ connectionString });

    super({
      adapter,
      log: ['error', 'warn'],
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}