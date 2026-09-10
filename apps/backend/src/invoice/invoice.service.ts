import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { formatUnits, getAddress, parseUnits, type Hex } from 'viem';
import { PrismaService } from '../database/prisma.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';
import { InvoicePaymentVerifierService } from './invoice-payment-verifier.service';
import {
  INVOICE_ERROR_CODES,
  INVOICE_MAX_AMOUNT_UNITS,
  INVOICE_PUBLIC_ID_BYTES,
  INVOICE_TOKEN_NAMES,
  InvoiceVerificationError,
  type InvoiceMerchantPrincipal,
  type InvoiceTokenSymbol,
} from './invoice.types';
import { CapabilityService } from '../capabilities/capability.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';
import { ExecutionIntentService } from '../execution-intent/execution-intent.service';

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
type InvoiceWithPayment = Prisma.InvoiceGetPayload<{
  include: { payment: true };
}>;

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: InvoicePaymentVerifierService,
    private readonly capabilities: CapabilityService,
    private readonly routing: PaymentRoutingService,
    private readonly intents: ExecutionIntentService,
  ) {}

  async create(principal: InvoiceMerchantPrincipal, dto: CreateInvoiceDto) {
    this.capabilities.assert(
      dto.settlementKind === 'PAYMENT_LINK' ? 'paymentLink' : 'invoice',
    );
    const tokenAddress = this.routing.canonicalToken(dto.token);
    const token = {
      address: tokenAddress,
      decimals: 6,
      name: INVOICE_TOKEN_NAMES[dto.token],
      symbol: dto.token,
    };
    this.routing.assertExecutable(
      this.routing.decide({
        network: this.routing.network,
        operation: 'INVOICE',
        tokenIn: token.address,
        tokenOut: token.address,
      }),
    );
    let amountUnits: bigint;
    try {
      amountUnits = parseUnits(dto.amount, token.decimals);
    } catch {
      throw new BadRequestException({
        code: 'INVOICE_INVALID_AMOUNT',
        message: 'Enter an exact token amount with at most 6 decimal places.',
      });
    }
    if (amountUnits <= 0n || amountUnits > INVOICE_MAX_AMOUNT_UNITS) {
      throw new BadRequestException({
        code: 'INVOICE_INVALID_AMOUNT',
        message:
          'Invoice amount must be greater than zero and at most 1,000,000,000 tokens.',
      });
    }
    const title = dto.title.trim();
    if (!title)
      throw new BadRequestException({
        code: 'INVOICE_INVALID_TITLE',
        message: 'Invoice title is required.',
      });
    const now = Date.now();
    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(now + DEFAULT_EXPIRY_MS);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= now ||
      expiresAt.getTime() > now + MAX_EXPIRY_MS
    ) {
      throw new BadRequestException({
        code: 'INVOICE_INVALID_EXPIRY',
        message: 'Expiry must be in the future and within one year.',
      });
    }

    const invoice = await this.prisma.invoice.create({
      data: {
        publicId: randomBytes(INVOICE_PUBLIC_ID_BYTES).toString('base64url'),
        merchantUserId: principal.merchantUserId,
        merchantWalletAddress: getAddress(principal.merchantWalletAddress),
        chainId: this.routing.chainId,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        amountUnits: amountUnits.toString(),
        title,
        description: dto.description?.trim() || null,
        invoiceNumber: dto.invoiceNumber?.trim() || null,
        settlementKind: dto.settlementKind ?? 'INVOICE',
        expiresAt,
      },
      include: { payment: true },
    });
    return this.toMerchant(invoice);
  }

  async list(principal: InvoiceMerchantPrincipal, query: ListInvoicesDto) {
    await this.expireOpenInvoices({ merchantUserId: principal.merchantUserId });
    const where = {
      merchantUserId: principal.merchantUserId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        include: { payment: true },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return {
      items: items.map((invoice) => this.toMerchant(invoice)),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async getOwned(principal: InvoiceMerchantPrincipal, id: string) {
    this.assertUuid(id);
    await this.expireOpenInvoices({
      id,
      merchantUserId: principal.merchantUserId,
    });
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, merchantUserId: principal.merchantUserId },
      include: { payment: true },
    });
    if (!invoice)
      throw new NotFoundException({
        code: INVOICE_ERROR_CODES.NOT_FOUND,
        message: 'Invoice not found.',
      });
    return this.toMerchant(invoice);
  }

  async cancel(principal: InvoiceMerchantPrincipal, id: string) {
    this.assertUuid(id);
    await this.expireOpenInvoices({
      id,
      merchantUserId: principal.merchantUserId,
    });
    const result = await this.prisma.invoice.updateMany({
      where: { id, merchantUserId: principal.merchantUserId, status: 'OPEN' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (result.count !== 1) {
      const existing = await this.prisma.invoice.findFirst({
        where: { id, merchantUserId: principal.merchantUserId },
      });
      if (!existing)
        throw new NotFoundException({
          code: INVOICE_ERROR_CODES.NOT_FOUND,
          message: 'Invoice not found.',
        });
      throw new ConflictException({
        code: INVOICE_ERROR_CODES.NOT_OPEN,
        message: 'Only an open invoice can be cancelled.',
      });
    }
    return this.getOwned(principal, id);
  }

  async getPublic(publicId: string) {
    this.assertPublicId(publicId);
    await this.expireOpenInvoices({ publicId });
    const invoice = await this.prisma.invoice.findUnique({
      where: { publicId },
      include: { payment: true },
    });
    if (!invoice)
      throw new NotFoundException({
        code: INVOICE_ERROR_CODES.NOT_FOUND,
        message: 'Payment request not found.',
      });
    this.capabilities.assert(
      invoice.settlementKind === 'PAYMENT_LINK' ? 'paymentLink' : 'invoice',
    );
    return this.toPublic(invoice);
  }

  async verifyPublicPayment(publicId: string, submittedHash: string) {
    this.assertPublicId(publicId);
    const transactionHash = submittedHash.toLowerCase();
    let invoice = await this.prisma.invoice.findUnique({
      where: { publicId },
      include: { payment: true },
    });
    if (!invoice)
      throw new NotFoundException({
        code: INVOICE_ERROR_CODES.NOT_FOUND,
        message: 'Payment request not found.',
      });
    const isPaymentLink = invoice.settlementKind === 'PAYMENT_LINK';
    this.capabilities.assert(isPaymentLink ? 'paymentLink' : 'invoice');
    this.routing.assertExecutable(
      this.routing.decide({
        network: this.routing.network,
        operation: isPaymentLink ? 'PAYMENT_LINK' : 'INVOICE',
        tokenIn: invoice.tokenAddress,
        tokenOut: invoice.tokenAddress,
      }),
    );
    const intent = await this.intents.getByTransactionHash(transactionHash);
    const expectedOperation =
      invoice.settlementKind === 'PAYMENT_LINK'
        ? 'PAYMENT_LINK_SETTLEMENT'
        : 'INVOICE_SETTLEMENT';
    if (
      intent.operation !== expectedOperation ||
      intent.externalReference !== invoice.publicId
    )
      throw new ConflictException({
        code: 'EXECUTION_INTENT_IMMUTABLE_CONFLICT',
        message: 'The submitted transaction is bound to another operation.',
      });
    await this.intents.beginVerification(intent.id);
    await this.expireOpenInvoices({ publicId });
    if (
      invoice.status === 'PAID' &&
      invoice.payment?.status === 'VERIFIED' &&
      invoice.payment.transactionHash === transactionHash
    ) {
      return this.toPublic(invoice);
    }
    this.assertAcceptsPayment(invoice);

    if (
      invoice.payment &&
      invoice.payment.transactionHash !== transactionHash
    ) {
      throw new ConflictException({
        code: INVOICE_ERROR_CODES.PAYMENT_ALREADY_SUBMITTED,
        message: 'This invoice already has a different submitted payment.',
      });
    }
    if (invoice.payment?.status === 'VERIFIED') return this.toPublic(invoice);
    if (!invoice.payment) {
      const reused = await this.prisma.invoicePayment.findUnique({
        where: { transactionHash },
      });
      if (reused && reused.invoiceId !== invoice.id) {
        throw new ConflictException({
          code: INVOICE_ERROR_CODES.HASH_REUSED,
          message: 'This transaction hash is already bound to another invoice.',
        });
      }
      try {
        await this.prisma.$transaction(async (tx) => {
          const locked = await tx.invoice.updateMany({
            where: { id: invoice!.id, status: 'OPEN' },
            data: { status: 'VERIFYING' },
          });
          if (locked.count !== 1)
            throw new ConflictException({
              code: INVOICE_ERROR_CODES.NOT_OPEN,
              message: 'Invoice state changed before payment verification.',
            });
          await tx.invoicePayment.create({
            data: {
              invoiceId: invoice!.id,
              transactionHash,
              status: 'VERIFYING',
            },
          });
        });
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          invoice = await this.prisma.invoice.findUnique({
            where: { publicId },
            include: { payment: true },
          });
          if (
            !invoice?.payment ||
            invoice.payment.transactionHash !== transactionHash
          ) {
            throw new ConflictException({
              code: INVOICE_ERROR_CODES.HASH_REUSED,
              message:
                'This transaction hash or invoice is already bound to another payment.',
            });
          }
        } else {
          throw error;
        }
      }
      invoice = await this.prisma.invoice.findUniqueOrThrow({
        where: { publicId },
        include: { payment: true },
      });
    }

    try {
      const verified = await this.verifier.verify({
        transactionHash: transactionHash as Hex,
        tokenAddress: getAddress(invoice.tokenAddress),
        merchantWalletAddress: getAddress(invoice.merchantWalletAddress),
        amountUnits: invoice.amountUnits,
      });
      await this.intents.completeWithVerifiedReceipt(intent.id, {
        network: this.routing.network,
        transactionHash: transactionHash as Hex,
        sourceWallet: verified.payerAddress,
        token: invoice.tokenAddress,
        recipient: invoice.merchantWalletAddress,
        amountUnits: invoice.amountUnits,
      });
      const invoiceId = invoice.id;
      await this.prisma.$transaction(async (tx) => {
        await tx.invoicePayment.updateMany({
          where: {
            invoiceId,
            transactionHash,
            status: { in: ['SUBMITTED', 'VERIFYING', 'REJECTED'] },
          },
          data: {
            status: 'VERIFIED',
            payerAddress: verified.payerAddress,
            verifiedAt: new Date(),
            rejectionCode: null,
          },
        });
        await tx.invoice.updateMany({
          where: { id: invoiceId, status: 'VERIFYING' },
          data: { status: 'PAID', paidAt: new Date() },
        });
      });
      return this.getPublic(publicId);
    } catch (error) {
      if (!(error instanceof InvoiceVerificationError)) throw error;
      if (error.retryable) {
        await this.prisma.invoicePayment.updateMany({
          where: {
            invoiceId: invoice.id,
            transactionHash,
            status: { in: ['SUBMITTED', 'VERIFYING', 'REJECTED'] },
          },
          data: { status: 'VERIFYING', rejectionCode: null },
        });
        throw new ServiceUnavailableException({
          code: error.code,
          message: error.message,
          retryable: true,
        });
      }
      await this.prisma.invoicePayment.updateMany({
        where: {
          invoiceId: invoice.id,
          transactionHash,
          status: { in: ['SUBMITTED', 'VERIFYING', 'REJECTED'] },
        },
        data: { status: 'REJECTED', rejectionCode: error.code },
      });
      throw new UnprocessableEntityException({
        code: error.code,
        message: error.message,
        retryable: false,
      });
    }
  }

  private assertAcceptsPayment(invoice: {
    status: string;
    expiresAt: Date | null;
  }) {
    if (invoice.status === 'PAID')
      throw new ConflictException({
        code: INVOICE_ERROR_CODES.ALREADY_PAID,
        message: 'This invoice is already paid.',
      });
    if (
      invoice.status === 'EXPIRED' ||
      (invoice.status === 'OPEN' &&
        invoice.expiresAt &&
        invoice.expiresAt <= new Date())
    )
      throw new GoneException({
        code: INVOICE_ERROR_CODES.EXPIRED,
        message: 'This invoice has expired.',
      });
    if (invoice.status === 'CANCELLED')
      throw new GoneException({
        code: INVOICE_ERROR_CODES.CANCELLED,
        message: 'This invoice was cancelled.',
      });
    if (!['OPEN', 'VERIFYING'].includes(invoice.status))
      throw new ConflictException({
        code: INVOICE_ERROR_CODES.NOT_OPEN,
        message: 'This invoice cannot accept payment.',
      });
  }

  private async expireOpenInvoices(where: {
    id?: string;
    publicId?: string;
    merchantUserId?: string;
  }) {
    await this.prisma.invoice.updateMany({
      where: { ...where, status: 'OPEN', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }

  private toPublic(invoice: InvoiceWithPayment) {
    const verifiedPayment =
      invoice.status === 'PAID' && invoice.payment?.status === 'VERIFIED'
        ? invoice.payment
        : null;
    const address = getAddress(invoice.merchantWalletAddress);
    return {
      publicId: invoice.publicId,
      settlementOperation:
        invoice.settlementKind === 'PAYMENT_LINK'
          ? 'PAYMENT_LINK_SETTLEMENT'
          : 'INVOICE_SETTLEMENT',
      merchantDisplayLabel: null,
      receivingAddress: address,
      receivingAddressShort: `${address.slice(0, 6)}...${address.slice(-4)}`,
      chain: {
        id: invoice.chainId,
        name:
          this.routing.network === 'arc-mainnet'
            ? 'Arc Mainnet'
            : 'Arc Testnet',
      },
      token: {
        symbol: invoice.tokenSymbol,
        name: INVOICE_TOKEN_NAMES[invoice.tokenSymbol as InvoiceTokenSymbol],
        address: invoice.tokenAddress,
        decimals: invoice.tokenDecimals,
      },
      amount: formatUnits(BigInt(invoice.amountUnits), invoice.tokenDecimals),
      amountUnits: invoice.amountUnits,
      title: invoice.title,
      description: invoice.description,
      expiresAt: invoice.expiresAt?.toISOString() ?? null,
      status: invoice.status,
      paymentStatus: invoice.payment?.status ?? null,
      verificationCode:
        invoice.payment?.status === 'REJECTED'
          ? invoice.payment.rejectionCode
          : null,
      transactionHash: verifiedPayment?.transactionHash ?? null,
      paidAt: verifiedPayment
        ? (invoice.paidAt?.toISOString() ??
          verifiedPayment.verifiedAt?.toISOString() ??
          null)
        : null,
    };
  }

  private toMerchant(invoice: InvoiceWithPayment) {
    return {
      id: invoice.id,
      ...this.toPublic(invoice),
      invoiceNumber: invoice.invoiceNumber,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
      cancelledAt: invoice.cancelledAt?.toISOString() ?? null,
      payerAddress:
        invoice.payment?.status === 'VERIFIED'
          ? invoice.payment.payerAddress
          : null,
    };
  }

  private assertUuid(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new NotFoundException({
        code: INVOICE_ERROR_CODES.NOT_FOUND,
        message: 'Invoice not found.',
      });
    }
  }

  private assertPublicId(publicId: string) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(publicId)) {
      throw new NotFoundException({
        code: INVOICE_ERROR_CODES.NOT_FOUND,
        message: 'Payment request not found.',
      });
    }
  }
}
