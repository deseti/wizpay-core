import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Param,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { StablefxCreateTradeDto } from './dto/stablefx-create-trade.dto';
import { StablefxFundDto } from './dto/stablefx-fund.dto';
import { StablefxFundingPresignDto } from './dto/stablefx-funding-presign.dto';
import { StablefxTradableQuoteDto } from './dto/stablefx-tradable-quote.dto';
import { UserSwapPrepareDto } from './dto/user-swap-prepare.dto';
import { UserSwapQuoteDto } from './dto/user-swap-quote.dto';
import { UserSwapStatusDto } from './dto/user-swap-status.dto';
import { StablefxExecutionService } from './stablefx-execution.service';
import { UserSwapService } from './user-swap.service';
import { USER_SWAP_ERROR_CODES } from './user-swap.types';

@Controller('user-swap')
@UsePipes(
  new ValidationPipe({
    exceptionFactory: () =>
      new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'User swap request validation failed.',
      }),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }),
)
export class UserSwapController {
  constructor(
    private readonly userSwapService: UserSwapService,
    private readonly stablefxExecutionService: StablefxExecutionService,
  ) {}

  @Post('quote')
  async quote(@Body() body: UserSwapQuoteDto) {
    return {
      data: await this.userSwapService.quote(body),
    };
  }

  @Post('prepare')
  async prepare(@Body() body: UserSwapPrepareDto) {
    return {
      data: await this.userSwapService.prepare(body),
    };
  }

  @Get('status')
  async status(@Query() query: UserSwapStatusDto) {
    return {
      data: await this.userSwapService.status(query),
    };
  }

  @Post('stablefx/quote')
  async stablefxQuote(@Body() body: StablefxTradableQuoteDto) {
    return {
      data: await this.stablefxExecutionService.createTradableQuote(body),
    };
  }

  @Post('stablefx/trades')
  async stablefxCreateTrade(@Body() body: StablefxCreateTradeDto) {
    return {
      data: await this.stablefxExecutionService.createTrade(body),
    };
  }

  @Post('stablefx/funding-presign')
  async stablefxFundingPresign(@Body() body: StablefxFundingPresignDto) {
    return {
      data: await this.stablefxExecutionService.createFundingPresign(body),
    };
  }

  @Post('stablefx/fund')
  async stablefxFund(@Body() body: StablefxFundDto) {
    return {
      data: await this.stablefxExecutionService.fund(body),
    };
  }

  @Get('stablefx/trades/:id')
  async stablefxGetTrade(@Param('id') tradeId: string) {
    return {
      data: await this.stablefxExecutionService.getTrade(tradeId),
    };
  }
}
