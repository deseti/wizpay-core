import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

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

  @IsOptional()
  @IsIn(['swapkit', 'stablefx', 'xylonet'])
  provider?: 'swapkit' | 'stablefx' | 'xylonet';

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  slippageBps?: number;
}
