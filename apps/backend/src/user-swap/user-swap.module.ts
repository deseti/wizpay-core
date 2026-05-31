import { Module } from '@nestjs/common';
import { StablefxExecutionService } from './stablefx-execution.service';
import { StablefxQuoteProviderService } from './stablefx-quote-provider.service';
import { UserSwapController } from './user-swap.controller';
import { UserSwapService } from './user-swap.service';

@Module({
  controllers: [UserSwapController],
  providers: [
    StablefxExecutionService,
    StablefxQuoteProviderService,
    UserSwapService,
  ],
  exports: [StablefxExecutionService, UserSwapService],
})
export class UserSwapModule {}
