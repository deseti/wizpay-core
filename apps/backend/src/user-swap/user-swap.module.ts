import { Module } from '@nestjs/common';
import { UserSwapController } from './user-swap.controller';
import { UserSwapService } from './user-swap.service';
import { XylonetQuoteProviderService } from './xylonet-quote-provider.service';

@Module({
  controllers: [UserSwapController],
  providers: [UserSwapService, XylonetQuoteProviderService],
  exports: [UserSwapService],
})
export class UserSwapModule {}
