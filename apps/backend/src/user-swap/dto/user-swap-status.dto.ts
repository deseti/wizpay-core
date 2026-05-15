import { IsNotEmpty, IsString } from 'class-validator';

export class UserSwapStatusDto {
  @IsString()
  @IsNotEmpty()
  txHash!: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;
}
