import { IsNotEmpty, IsString } from 'class-validator';

export class AppWalletSwapQuoteDto {
  @IsString()
  @IsNotEmpty()
  tokenIn!: string;

  @IsString()
  @IsNotEmpty()
  tokenOut!: string;

  @IsString()
  @IsNotEmpty()
  amountIn!: string;

  @IsString()
  @IsNotEmpty()
  fromAddress!: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;
}
