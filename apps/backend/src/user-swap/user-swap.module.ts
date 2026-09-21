import { Module } from '@nestjs/common';
import { UserSwapController } from './user-swap.controller';
import { UserSwapService } from './user-swap.service';
import { MainnetUniswapV4QuoteService } from './mainnet-uniswap-v4-quote.service';
import { MainnetUniswapV4ReadinessService } from './mainnet-uniswap-v4-readiness.service';
import { MainnetUniswapV4Service } from './mainnet-uniswap-v4.service';
import { MainnetUniswapV4Controller } from './mainnet-uniswap-v4.controller';

@Module({
  controllers: [UserSwapController, MainnetUniswapV4Controller],
  providers: [
    UserSwapService,
    MainnetUniswapV4QuoteService,
    MainnetUniswapV4ReadinessService,
    MainnetUniswapV4Service,
  ],
  exports: [
    UserSwapService,
    MainnetUniswapV4QuoteService,
    MainnetUniswapV4ReadinessService,
    MainnetUniswapV4Service,
  ],
})
export class UserSwapModule {}
