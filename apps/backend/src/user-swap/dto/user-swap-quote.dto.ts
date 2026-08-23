import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  toAddress!: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;

  @IsInt()
  @Min(1)
  @Max(1_000)
  slippageBps!: number;
}
