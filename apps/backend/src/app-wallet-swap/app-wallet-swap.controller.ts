import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
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
import { AppWalletXylonetOperationDto } from './dto/app-wallet-xylonet-operation.dto';
import { AppWalletXylonetChallengeResultDto } from './dto/app-wallet-xylonet-challenge-result.dto';
import { AppWalletXylonetUserControlledExecutorService } from './app-wallet-xylonet-user-controlled-executor.service';

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
  constructor(
    private readonly appWalletSwapService: AppWalletSwapService,
    private readonly xylonetExecutor: AppWalletXylonetUserControlledExecutorService,
  ) {}

  @Post('xylonet/operations')
  async createXylonetOperation(
    @Headers('x-user-token') userToken: string,
    @Body() body: AppWalletXylonetOperationDto,
  ) {
    return {
      data: await this.xylonetExecutor.createOperation(body, userToken),
    };
  }

  @Post('xylonet/quote')
  async quoteXylonetOperation(
    @Headers('x-user-token') userToken: string,
    @Body() body: AppWalletXylonetOperationDto,
  ) {
    return { data: await this.xylonetExecutor.quote(body, userToken) };
  }

  @Get('xylonet/operations/:id')
  async getXylonetOperation(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
  ) {
    return {
      data: await this.xylonetExecutor.getOperation(operationId, userToken),
    };
  }

  @Post('xylonet/operations/:id/approval-challenge')
  async createXylonetApprovalChallenge(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
  ) {
    return {
      data: await this.xylonetExecutor.createApprovalChallenge(
        operationId,
        userToken,
      ),
    };
  }

  @Post('xylonet/operations/:id/approval-result')
  async recordXylonetApprovalResult(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
    @Body() body: AppWalletXylonetChallengeResultDto,
  ) {
    return {
      data: await this.xylonetExecutor.recordChallengeResult(
        operationId,
        'approval',
        body,
        userToken,
      ),
    };
  }

  @Post('xylonet/operations/:id/swap-challenge')
  async createXylonetSwapChallenge(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
  ) {
    return {
      data: await this.xylonetExecutor.createSwapChallenge(
        operationId,
        userToken,
      ),
    };
  }

  @Post('xylonet/operations/:id/swap-result')
  async recordXylonetSwapResult(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
    @Body() body: AppWalletXylonetChallengeResultDto,
  ) {
    return {
      data: await this.xylonetExecutor.recordChallengeResult(
        operationId,
        'swap',
        body,
        userToken,
      ),
    };
  }

  @Post('xylonet/operations/:id/poll')
  async pollXylonetOperation(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
  ) {
    return { data: await this.xylonetExecutor.poll(operationId, userToken) };
  }

  @Post('quote')
  async quote(@Body() body: AppWalletSwapQuoteDto) {
    return {
      data: await this.appWalletSwapService.quote(body),
    };
  }

  @Post('operations')
  async createOperation(@Body() body: AppWalletSwapOperationDto) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.createOperation(body),
      ),
    };
  }

  @Post('operations/:id/deposit')
  async submitDeposit(
    @Param('id') operationId: string,
    @Body() body: AppWalletSwapDepositDto,
  ) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.submitDeposit(operationId, body),
      ),
    };
  }

  @Post('operations/:id/deposit-txhash')
  async attachDepositTxHash(
    @Param('id') operationId: string,
    @Body() body: AppWalletSwapDepositTxHashDto,
  ) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.attachDepositTxHash(operationId, body),
      ),
    };
  }

  @Post('operations/:id/resolve-deposit-txhash')
  async resolveDepositTxHash(@Param('id') operationId: string) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.resolveDepositTxHash(operationId),
      ),
    };
  }

  @Post('operations/:id/confirm-deposit')
  async confirmDeposit(@Param('id') operationId: string) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.confirmDeposit(operationId),
      ),
    };
  }

  @Post('operations/:id/execute')
  async execute(@Param('id') operationId: string) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.execute(operationId),
      ),
    };
  }

  @Post('operations/:id/refund')
  async refund(@Param('id') operationId: string) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.refund(operationId),
      ),
    };
  }

  @Get('operations/:id')
  async getOperation(@Param('id') operationId: string) {
    return {
      data: this.appWalletSwapService.toPublicOperation(
        await this.appWalletSwapService.getOperation(operationId),
      ),
    };
  }
}
