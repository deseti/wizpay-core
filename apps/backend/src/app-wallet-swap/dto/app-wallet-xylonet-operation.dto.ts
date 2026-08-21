import { IsIn, IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class AppWalletXylonetOperationDto {
  @IsString()
  @IsNotEmpty()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  walletAddress!: string;

  @IsString()
  @IsIn(['ARC-TESTNET'])
  chain!: string;

  @IsString()
  @IsIn(['USDC', 'EURC'])
  tokenIn!: string;

  @IsString()
  @IsIn(['USDC', 'EURC'])
  tokenOut!: string;

  @IsString()
  @IsNotEmpty()
  amountIn!: string;

  @IsInt()
  @Min(1)
  @Max(1_000)
  slippageBps!: number;
}
