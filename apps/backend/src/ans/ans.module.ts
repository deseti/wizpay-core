import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnsController } from './ans.controller';
import { AnsService } from './ans.service';

/**
 * Standalone ANS module for direct RPC name resolution and lightweight helpers.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AnsController],
  providers: [AnsService],
  exports: [AnsService],
})
export class AnsModule {}