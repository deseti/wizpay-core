import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserSwapPrepareDto } from './dto/user-swap-prepare.dto';
import { UserSwapQuoteDto } from './dto/user-swap-quote.dto';
import { UserSwapStatusDto } from './dto/user-swap-status.dto';
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
  constructor(private readonly userSwapService: UserSwapService) {}

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
}
