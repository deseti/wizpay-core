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

  @Get('operations/:id')
  getOperation(@Param('id') operationId: string) {
    return {
      data: this.appWalletSwapService.getOperation(operationId),
    };
  }
}
