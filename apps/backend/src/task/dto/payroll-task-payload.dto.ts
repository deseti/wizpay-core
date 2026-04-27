import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const SUPPORTED_TOKENS = ['USDC', 'EURC'] as const;
type TokenSymbol = (typeof SUPPORTED_TOKENS)[number];

export class PayrollRecipientDto {
  @IsString({ message: 'address is required' })
  @Matches(/^0x[a-fA-F0-9]{40}$/, {
    message: 'address must be a valid Ethereum address (0x + 40 hex chars)',
  })
  address!: string;

  @IsString({ message: 'amount is required' })
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'amount must be a positive numeric string (e.g. "100.50")',
  })
  amount!: string;

  @IsOptional()
  @IsEnum(SUPPORTED_TOKENS, {
    message: `targetToken must be one of: ${SUPPORTED_TOKENS.join(', ')}`,
  })
  targetToken?: string;
}

/**
 * Strongly typed payload for payroll tasks.
 *
 * Frontend sends:
 * ```json
 * {
 *   "type": "payroll",
 *   "payload": {
 *     "sourceToken": "USDC",
 *     "recipients": [
 *       { "address": "0xabc...", "amount": "100.50", "targetToken": "EURC" }
 *     ],
 *     "referenceId": "PAY-240426-AB1C"
 *   }
 * }
 * ```
 */
export class PayrollTaskPayloadDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one recipient is required' })
  @ArrayMaxSize(500, { message: 'Maximum 500 recipients per task' })
  @ValidateNested({ each: true })
  @Type(() => PayrollRecipientDto)
  recipients!: PayrollRecipientDto[];

  @IsEnum(SUPPORTED_TOKENS, {
    message: `sourceToken must be one of: ${SUPPORTED_TOKENS.join(', ')}`,
  })
  sourceToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'referenceId must be 64 characters or less' })
  referenceId?: string;

  @IsOptional()
  @IsString()
  network?: string;
}
