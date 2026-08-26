import { IsString, Matches } from 'class-validator';

export class VerifyInvoicePaymentDto {
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{64}$/, {
    message: 'transactionHash must be a 32-byte EVM transaction hash',
  })
  transactionHash!: string;
}
