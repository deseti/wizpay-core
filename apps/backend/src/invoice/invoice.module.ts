import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InvoiceAuthService } from './invoice-auth.service';
import { InvoiceController } from './invoice.controller';
import { InvoicePaymentVerifierService } from './invoice-payment-verifier.service';
import { InvoiceService } from './invoice.service';
import { PublicInvoiceController } from './public-invoice.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [InvoiceController, PublicInvoiceController],
  providers: [
    InvoiceAuthService,
    InvoicePaymentVerifierService,
    InvoiceService,
  ],
})
export class InvoiceModule {}
