import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class StablefxCreateTradeDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsString()
  @IsNotEmpty()
  quoteId!: string;

  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsOptional()
  @IsString()
  selectedAddress?: string;

  @IsObject()
  message!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  signature!: string;

  @IsString()
  @IsNotEmpty()
  tokenIn!: string;

  @IsString()
  @IsNotEmpty()
  tokenOut!: string;

  @IsString()
  @IsNotEmpty()
  walletMode!: string;
}
