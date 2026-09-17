import { Type } from 'class-transformer';
import {
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class MainnetUniswapV4QuoteObservationDto {
  @IsInt()
  chainId!: number;

  @IsString()
  quoterAddress!: string;

  @IsString()
  poolId!: string;

  @IsString()
  tokenInAddress!: string;

  @IsString()
  tokenOutAddress!: string;

  @IsString()
  amountIn!: string;

  @IsInt()
  @Min(1)
  blockNumber!: number;

  @IsString()
  amountOut!: string;

  @IsString()
  gasEstimate!: string;
}

export class MainnetUniswapV4QuoteDto {
  @IsInt()
  chainId!: number;

  @IsString()
  tokenInAddress!: string;

  @IsString()
  tokenOutAddress!: string;

  @IsString()
  amountIn!: string;

  @IsString()
  recipient!: string;

  @IsString()
  walletAddress!: string;

  @IsString()
  walletControl!: string;

  @IsInt()
  @Min(1)
  @Max(500)
  slippageBps!: number;

  @IsInt()
  deadline!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => MainnetUniswapV4QuoteObservationDto)
  quoteResult?: MainnetUniswapV4QuoteObservationDto;
}

export class MainnetUniswapV4PrepareDto extends MainnetUniswapV4QuoteDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2 ** 48 - 1)
  permit2Nonce?: number;

  @IsOptional()
  @IsString()
  @Matches(/^0x(?:[0-9a-fA-F]{2})+$/)
  permit2Signature?: string;
}

export class MainnetUniswapV4ReceiptLogDto {
  @IsString()
  address!: string;

  @IsString({ each: true })
  topics!: string[];

  @IsString()
  data!: string;
}

export class MainnetUniswapV4ReceiptDto {
  @IsInt()
  chainId!: number;

  @IsIn(['success', 'reverted', 0, 1])
  status!: 'success' | 'reverted' | 0 | 1;

  @IsString()
  from!: string;

  @IsString()
  to!: string;

  @IsString()
  @Matches(/^0x(?:[0-9a-fA-F]{2})*$/)
  input!: string;

  @IsString()
  @Matches(/^\d+$/)
  value!: string;

  @ValidateNested({ each: true })
  @Type(() => MainnetUniswapV4ReceiptLogDto)
  logs!: MainnetUniswapV4ReceiptLogDto[];
}

export class MainnetUniswapV4VerifyReceiptDto {
  @ValidateNested()
  @Type(() => MainnetUniswapV4ReceiptDto)
  receipt!: MainnetUniswapV4ReceiptDto;

  @ValidateNested()
  @Type(() => MainnetUniswapV4PrepareDto)
  request!: MainnetUniswapV4PrepareDto;
}
