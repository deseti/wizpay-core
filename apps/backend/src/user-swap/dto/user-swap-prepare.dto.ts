import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class UserSwapPrepareDto {
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

  @IsOptional()
  @IsInt()
  @Min(0)
  slippageBps?: number;
}
