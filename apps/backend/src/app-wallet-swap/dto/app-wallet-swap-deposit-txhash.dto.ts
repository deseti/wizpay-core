import { IsString } from 'class-validator';

export class AppWalletSwapDepositTxHashDto {
  @IsString()
  depositTxHash!: string;
}
