import { Module } from '@nestjs/common';
import { UserSwapController } from './user-swap.controller';
import { UserSwapService } from './user-swap.service';

@Module({
  controllers: [UserSwapController],
  providers: [UserSwapService],
})
export class UserSwapModule {}
