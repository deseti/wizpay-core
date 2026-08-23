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
import { AppWalletXylonetChallengeResultDto } from './dto/app-wallet-xylonet-challenge-result.dto';
import { AppWalletXylonetOperationDto } from './dto/app-wallet-xylonet-operation.dto';
import { AppWalletXylonetUserControlledExecutorService } from './app-wallet-xylonet-user-controlled-executor.service';
import { APP_WALLET_XYLONET_ERRORS } from './app-wallet-xylonet.types';

@Controller('app-wallet-swap')
@UsePipes(
  new ValidationPipe({
    exceptionFactory: () =>
      new BadRequestException({
        code: APP_WALLET_XYLONET_ERRORS.INVALID_REQUEST,
        message: 'XyloNet App Wallet swap request validation failed.',
      }),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }),
)
export class AppWalletSwapController {
  constructor(
    private readonly xylonetExecutor: AppWalletXylonetUserControlledExecutorService,
  ) {}

  @Post('xylonet/quote')
  async quote(
    @Headers('x-user-token') userToken: string,
    @Body() body: AppWalletXylonetOperationDto,
  ) {
    return { data: await this.xylonetExecutor.quote(body, userToken) };
  }

  @Post('xylonet/operations')
  async createOperation(
    @Headers('x-user-token') userToken: string,
    @Body() body: AppWalletXylonetOperationDto,
  ) {
    return {
      data: await this.xylonetExecutor.createOperation(body, userToken),
    };
  }

  @Get('xylonet/operations/:id')
  async getOperation(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
  ) {
    return {
      data: await this.xylonetExecutor.getOperation(operationId, userToken),
    };
  }

  @Post('xylonet/operations/:id/approval-challenge')
  async createApprovalChallenge(
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
  async recordApprovalResult(
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
  async createSwapChallenge(
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
  async recordSwapResult(
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
  async poll(
    @Headers('x-user-token') userToken: string,
    @Param('id') operationId: string,
  ) {
    return { data: await this.xylonetExecutor.poll(operationId, userToken) };
  }
}
