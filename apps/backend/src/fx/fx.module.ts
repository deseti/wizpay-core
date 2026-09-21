import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FxRoutingGuard } from './fx-routing-guard.service';
import { SettlementValidator } from './settlement-validator.service';
import { SettlementPollerService } from './settlement-poller.service';
import { FxRetryService } from './fx-retry.service';
import { FxBatchService } from './fx-batch.service';
import { LpWindDownService } from './lp-wind-down.service';

/**
 * FxModule is the NestJS module that registers Mainnet FX services.
 *
 * Services registered:
 * - FxRoutingGuard (Mainnet-only routing + circuit breaker)
 * - SettlementValidator (output validation)
 * - SettlementPollerService (settlement status tracking)
 * - FxRetryService (retry policy with quote freshness)
 * - FxBatchService (batch validation)
 * - LpWindDownService (wind-down management)
 */
@Module({
  imports: [ConfigModule],
  providers: [
    FxRoutingGuard,
    SettlementValidator,
    SettlementPollerService,
    FxRetryService,
    FxBatchService,
    LpWindDownService,
  ],
  exports: [
    FxRoutingGuard,
    SettlementValidator,
    SettlementPollerService,
    FxRetryService,
    FxBatchService,
    LpWindDownService,
  ],
})
export class FxModule {}
