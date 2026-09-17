import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  MainnetUniswapV4PrepareDto,
  MainnetUniswapV4QuoteDto,
  MainnetUniswapV4VerifyReceiptDto,
} from './dto/mainnet-uniswap-v4.dto';
import { ARC_MAINNET_UNISWAP_V4_ERROR_CODES } from './mainnet-uniswap-v4-readiness.service';
import { MainnetUniswapV4Service } from './mainnet-uniswap-v4.service';

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
  constructor(private readonly mainnetUniswapV4: MainnetUniswapV4Service) {}

  @Post('quote')
  quote(@Body() body: MainnetUniswapV4QuoteDto) {
    return { data: this.mainnetUniswapV4.inspectQuote(body) };
  }

  @Post('prepare')
  prepare(@Body() body: MainnetUniswapV4PrepareDto) {
    return { data: this.mainnetUniswapV4.prepare(body) };
  }

  @Post('execute')
  execute(@Body() body: MainnetUniswapV4PrepareDto) {
    return { data: this.mainnetUniswapV4.execute(body) };
  }

  @Post('verify-receipt')
  verifyReceipt(@Body() body: MainnetUniswapV4VerifyReceiptDto) {
    return {
      data: this.mainnetUniswapV4.verifyReceipt(body.receipt, body.request),
    };
  }
}
