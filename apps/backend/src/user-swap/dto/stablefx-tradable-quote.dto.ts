import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class StablefxTradableQuoteDto {
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
  recipientAddress?: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;
}
