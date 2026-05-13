import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FxRoutingGuard } from './fx-routing-guard.service';
import { StableFXRfqClient } from './stablefx-rfq-client.service';
import { SettlementValidator } from './settlement-validator.service';
import { SettlementPollerService } from './settlement-poller.service';
import { FxRetryService } from './fx-retry.service';
import { FxBatchService } from './fx-batch.service';
import { LpWindDownService } from './lp-wind-down.service';

/**
 * FxModule is the NestJS module that registers all FX-related services
 * for the StableFX RFQ migration.
 *
 * Services registered:
 * - FxRoutingGuard (feature flag + circuit breaker)
 * - StableFXRfqClient (Circle API adapter)
 * - SettlementValidator (output validation)
 * - SettlementPollerService (BullMQ worker)
 * - FxRetryService (retry logic with quote freshness)
 * - FxBatchService (batch validation + cross-currency execution)
 * - LpWindDownService (LP wind-down management)
 */
@Module({
  imports: [ConfigModule],
  providers: [
    FxRoutingGuard,
    StableFXRfqClient,
    SettlementValidator,
    SettlementPollerService,
    FxRetryService,
    FxBatchService,
    LpWindDownService,
  ],
  exports: [
    FxRoutingGuard,
    StableFXRfqClient,
    SettlementValidator,
    SettlementPollerService,
    FxRetryService,
    FxBatchService,
    LpWindDownService,
  ],
})
export class FxModule {}
