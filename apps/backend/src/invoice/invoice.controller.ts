import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';
import { InvoiceAuthService } from './invoice-auth.service';
import { InvoiceService } from './invoice.service';
import { CapabilityService } from '../capabilities/capability.service';

const invoiceValidationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () =>
    new BadRequestException({
      code: 'INVOICE_INVALID_REQUEST',
      message: 'Invoice request validation failed.',
    }),
});

@Controller('invoices')
@UsePipes(invoiceValidationPipe)
export class InvoiceController {
  constructor(
    private readonly auth: InvoiceAuthService,
    private readonly invoices: InvoiceService,
    private readonly capabilities: CapabilityService,
  ) {}

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: CreateInvoiceDto,
  ) {
    this.capabilities.assert('invoice');
    const principal = await this.auth.authenticate(authorization);
    return { data: await this.invoices.create(principal, body) };
  }

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: ListInvoicesDto,
  ) {
    this.capabilities.assert('invoice');
    const principal = await this.auth.authenticate(authorization);
    return { data: await this.invoices.list(principal, query) };
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    this.capabilities.assert('invoice');
    const principal = await this.auth.authenticate(authorization);
    return { data: await this.invoices.getOwned(principal, id) };
  }

  @Post(':id/cancel')
  async cancel(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    this.capabilities.assert('invoice');
    const principal = await this.auth.authenticate(authorization);
    return { data: await this.invoices.cancel(principal, id) };
  }
}
