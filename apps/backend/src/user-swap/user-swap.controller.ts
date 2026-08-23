import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserSwapQuoteDto } from './dto/user-swap-quote.dto';
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
}
