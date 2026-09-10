import { Global, Module } from '@nestjs/common';
import { CapabilityController } from './capability.controller';
import { CapabilityService } from './capability.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';

@Global()
@Module({
  controllers: [CapabilityController],
  providers: [CapabilityService, PaymentRoutingService],
  exports: [CapabilityService, PaymentRoutingService],
})
export class CapabilityModule {}
