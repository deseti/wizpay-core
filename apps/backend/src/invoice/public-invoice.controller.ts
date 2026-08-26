import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { VerifyInvoicePaymentDto } from './dto/verify-invoice-payment.dto';
import { InvoiceService } from './invoice.service';
import { INVOICE_ERROR_CODES } from './invoice.types';

const publicValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () =>
    new BadRequestException({
      code: 'INVOICE_INVALID_REQUEST',
      message: 'Payment verification request validation failed.',
    }),
});

@Controller('public/invoices')
@UsePipes(publicValidationPipe)
export class PublicInvoiceController {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly invoices: InvoiceService) {}

  @Get(':publicId')
  async get(@Param('publicId') publicId: string) {
    return { data: await this.invoices.getPublic(publicId) };
  }

  @Post(':publicId/payments/verify')
  async verify(
    @Param('publicId') publicId: string,
    @Ip() ip: string,
    @Body() body: VerifyInvoicePaymentDto,
  ) {
    this.enforceRateLimit(`${ip}:${publicId}`);
    return {
      data: await this.invoices.verifyPublicPayment(
        publicId,
        body.transactionHash,
      ),
    };
  }

  private enforceRateLimit(key: string) {
    const now = Date.now();
    const active = (this.attempts.get(key) ?? []).filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (active.length >= 12) {
      throw new HttpException(
        {
          code: INVOICE_ERROR_CODES.RATE_LIMITED,
          message:
            'Too many verification requests. Wait before checking again.',
          retryable: true,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    active.push(now);
    this.attempts.set(key, active);
    if (this.attempts.size > 5_000) {
      for (const [candidate, timestamps] of this.attempts) {
        if (!timestamps.some((timestamp) => now - timestamp < 60_000))
          this.attempts.delete(candidate);
      }
    }
  }
}
