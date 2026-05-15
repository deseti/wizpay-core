import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class OfficialSwapExecuteDto {
  @IsString()
  @IsNotEmpty()
  sellToken!: string;

  @IsString()
  @IsNotEmpty()
  buyToken!: string;

  @IsString()
  @IsNotEmpty()
  sellAmount!: string;

  @IsString()
  @IsNotEmpty()
  minOutput!: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;

  @IsOptional()
  @IsString()
  walletAddress?: string;
}
