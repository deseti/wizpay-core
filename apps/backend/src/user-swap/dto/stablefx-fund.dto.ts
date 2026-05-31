import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class StablefxFundDto {
  @IsString()
  @IsNotEmpty()
  signature!: string;

  @IsObject()
  permit2!: Record<string, unknown>;
}
