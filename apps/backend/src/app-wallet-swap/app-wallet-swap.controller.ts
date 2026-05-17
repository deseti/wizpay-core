import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AppWalletSwapDepositDto } from './dto/app-wallet-swap-deposit.dto';
import { AppWalletSwapDepositTxHashDto } from './dto/app-wallet-swap-deposit-txhash.dto';
import { AppWalletSwapOperationDto } from './dto/app-wallet-swap-operation.dto';
import { AppWalletSwapQuoteDto } from './dto/app-wallet-swap-quote.dto';
import { AppWalletSwapService } from './app-wallet-swap.service';
import { APP_WALLET_SWAP_ERROR_CODES } from './app-wallet-swap.types';

@Controller('app-wallet-swap')
@UsePipes(
  new ValidationPipe({
    exceptionFactory: () =>
      new BadRequestException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap request validation failed.',
      }),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }),
)
export class AppWalletSwapController {
  constructor(private readonly appWalletSwapService: AppWalletSwapService) {}

  @Post('quote')
  async quote(@Body() body: AppWalletSwapQuoteDto) {
    return {
      data: await this.appWalletSwapService.quote(body),
    };
  }

  @Post('operations')
  async createOperation(@Body() body: AppWalletSwapOperationDto) {
    return {
      data: await this.appWalletSwapService.createOperation(body),
    };
  }

  @Post('operations/:id/deposit')
  async submitDeposit(
    @Param('id') operationId: string,
    @Body() body: AppWalletSwapDepositDto,
  ) {
    return {
      data: await this.appWalletSwapService.submitDeposit(operationId, body),
    };
  }

  @Post('operations/:id/deposit-txhash')
  async attachDepositTxHash(
    @Param('id') operationId: string,
    @Body() body: AppWalletSwapDepositTxHashDto,
  ) {
    return {
      data: await this.appWalletSwapService.attachDepositTxHash(
        operationId,
        body,
      ),
    };
  }

  @Post('operations/:id/resolve-deposit-txhash')
  async resolveDepositTxHash(@Param('id') operationId: string) {
    return {
      data: await this.appWalletSwapService.resolveDepositTxHash(operationId),
    };
  }

  @Post('operations/:id/confirm-deposit')
  async confirmDeposit(@Param('id') operationId: string) {
    return {
      data: await this.appWalletSwapService.confirmDeposit(operationId),
    };
  }

  @Post('operations/:id/execute')
  async execute(@Param('id') operationId: string) {
    return {
      data: await this.appWalletSwapService.execute(operationId),
    };
  }

  @Get('operations/:id')
  async getOperation(@Param('id') operationId: string) {
    return {
      data: await this.appWalletSwapService.getOperation(operationId),
    };
  }
}
