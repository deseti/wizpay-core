import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  MainnetUniswapV4PayrollQuoteDto,
  MainnetUniswapV4PrepareDto,
  MainnetUniswapV4QuoteDto,
  MainnetUniswapV4VerifyReceiptDto,
} from './dto/mainnet-uniswap-v4.dto';
import { ARC_MAINNET_UNISWAP_V4_ERROR_CODES } from './mainnet-uniswap-v4-readiness.service';
import { MainnetUniswapV4Service } from './mainnet-uniswap-v4.service';
import { InvoiceAuthService } from '../invoice/invoice-auth.service';
import { PrismaService } from '../database/prisma.service';

@Controller('user-swap/mainnet')
@UsePipes(
  new ValidationPipe({
    exceptionFactory: () =>
      new BadRequestException({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.INVALID_REQUEST,
        message: 'Arc Mainnet Uniswap V4 request validation failed.',
      }),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }),
)
export class MainnetUniswapV4Controller {
  constructor(
    private readonly mainnetUniswapV4: MainnetUniswapV4Service,
    private readonly auth: InvoiceAuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('quote')
  async quote(@Body() body: MainnetUniswapV4QuoteDto) {
    return { data: await this.mainnetUniswapV4.inspectQuote(body) };
  }

  @Get('readiness')
  async readiness() {
    try {
      return { data: await this.mainnetUniswapV4.liveReadiness() };
    } catch (error) {
      const response =
        error && typeof error === 'object' && 'getResponse' in error
          ? (error as { getResponse(): unknown }).getResponse()
          : null;
      const message =
        response && typeof response === 'object' && 'message' in response
          ? String((response as Record<string, unknown>).message)
          : 'Arc Mainnet swaps are unavailable.';
      return {
        data: {
          available: false,
          executable: false,
          poolIdentityStatus: 'candidate-unverified',
          blockers: [message],
        },
      };
    }
  }

  @Post('prepare')
  async prepare(@Body() body: MainnetUniswapV4PrepareDto) {
    return { data: await this.mainnetUniswapV4.prepare(body) };
  }

  @Post('payroll-quote')
  async payrollQuote(@Body() body: MainnetUniswapV4PayrollQuoteDto) {
    return { data: await this.mainnetUniswapV4.payrollCrossTokenQuote(body) };
  }

  @Post('execute')
  execute(@Body() body: MainnetUniswapV4PrepareDto) {
    return { data: this.mainnetUniswapV4.execute(body) };
  }

  @Post('verify-receipt')
  async verifyReceipt(@Body() body: MainnetUniswapV4VerifyReceiptDto) {
    return {
      data: await this.mainnetUniswapV4.verifyReceipt(body.receipt, body.request),
    };
  }

  @Post('confirm')
  async confirm(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { transactionHash?: unknown },
  ) {
    const principal = await this.auth.authenticate(authorization);
    const verified = await this.mainnetUniswapV4.confirmTransaction(
      typeof body.transactionHash === 'string' ? body.transactionHash : '',
      principal.merchantWalletAddress,
    );
    const stored = await this.prisma.verifiedSwapTransaction.upsert({
      where: { transactionHash: verified.transactionHash },
      create: { ...verified, completedAt: new Date() },
      update: {},
    });
    if (stored.walletAddress.toLowerCase() !== verified.walletAddress.toLowerCase()) {
      throw new BadRequestException({
        code: 'SWAP_RECEIPT_OWNER_CONFLICT',
        message: 'The verified swap belongs to another wallet.',
      });
    }
    return { data: stored };
  }
}
