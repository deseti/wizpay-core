import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UserSwapQuoteDto {
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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  toAddress?: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;
}
