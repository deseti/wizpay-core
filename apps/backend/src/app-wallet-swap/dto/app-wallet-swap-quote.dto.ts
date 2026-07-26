import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { AppWalletSwapProvider } from '../app-wallet-swap.types';

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

  @IsOptional()
  @IsString()
  @IsIn(['swapkit', 'stablefx'])
  provider?: AppWalletSwapProvider;
}
