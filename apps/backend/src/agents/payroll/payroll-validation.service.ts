import { Injectable, Logger } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';
import { BlockchainService } from '../../adapters/blockchain.service';

export interface ValidatedRecipient {
  address: string;
  amount: string;
  amountUnits: bigint;
  targetToken: string;
}

export interface PayrollValidationResult {
  valid: boolean;
  recipients: ValidatedRecipient[];
  errors: string[];
}

const SUPPORTED_TOKENS = ['USDC', 'EURC'] as const;
const TOKEN_DECIMALS: Record<string, number> = { USDC: 6, EURC: 6 };
const MAX_BATCH_SIZE = 50;
const MAX_REFERENCE_ID_LENGTH = 64;

@Injectable()
export class PayrollValidationService {
  private readonly logger = new Logger(PayrollValidationService.name);

  constructor(private readonly blockchainService: BlockchainService) {}

  validate(payload: Record<string, unknown>): PayrollValidationResult {
    const errors: string[] = [];
    const sourceToken = payload.sourceToken as string | undefined;
    if (
      !sourceToken ||
      !SUPPORTED_TOKENS.includes(
        sourceToken as (typeof SUPPORTED_TOKENS)[number],
      )
    ) {
      errors.push(
        `sourceToken must be one of: ${SUPPORTED_TOKENS.join(', ')}. Got: "${sourceToken}"`,
      );
    }
    const referenceId = payload.referenceId as string | undefined;
    if (referenceId && referenceId.length > MAX_REFERENCE_ID_LENGTH) {
      errors.push(
        `referenceId must be ${MAX_REFERENCE_ID_LENGTH} characters or less`,
      );
    }
    const recipients = payload.recipients;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      errors.push('recipients must be a non-empty array');
      return { valid: false, recipients: [], errors };
    }
    if (recipients.length > MAX_BATCH_SIZE) {
      this.logger.log(
        `Payload has ${recipients.length} recipients — will be batched into groups of ${MAX_BATCH_SIZE}`,
      );
    }

    const decimals = TOKEN_DECIMALS[sourceToken ?? 'USDC'] ?? 6;
    const validatedRecipients: ValidatedRecipient[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i] as Record<string, unknown> | undefined;
      const prefix = `recipients[${i}]`;
      if (!recipient || typeof recipient !== 'object') {
        errors.push(`${prefix}: must be an object`);
        continue;
      }
      const addressValue = this.getRecipientAddressValue(recipient);
      const normalizedAddress =
        addressValue && isAddress(addressValue.trim())
          ? getAddress(addressValue.trim())
          : null;
      if (!addressValue) errors.push(`${prefix}.address: required`);
      else if (!normalizedAddress)
        errors.push(
          `${prefix}.address: invalid Ethereum address "${addressValue}"`,
        );

      const amount = recipient.amount as string | number | undefined;
      if (amount === undefined || amount === null || amount === '')
        errors.push(`${prefix}.amount: required`);
      else if (
        isNaN(typeof amount === 'number' ? amount : Number(amount)) ||
        Number(amount) <= 0
      )
        errors.push(
          `${prefix}.amount: must be a positive number, got "${amount}"`,
        );

      const targetToken =
        (recipient.targetToken as string) ?? sourceToken ?? 'USDC';
      if (
        !SUPPORTED_TOKENS.includes(
          targetToken as (typeof SUPPORTED_TOKENS)[number],
        )
      )
        errors.push(
          `${prefix}.targetToken: must be one of ${SUPPORTED_TOKENS.join(', ')}. Got: "${targetToken}"`,
        );
      if (
        normalizedAddress &&
        amount !== undefined &&
        amount !== null &&
        amount !== ''
      ) {
        const amountStr = String(amount);
        if (!isNaN(Number(amountStr)) && Number(amountStr) > 0)
          validatedRecipients.push({
            address: normalizedAddress,
            amount: amountStr,
            amountUnits: this.parseAmountToUnits(amountStr, decimals),
            targetToken,
          });
      }
    }
    return {
      valid: errors.length === 0,
      recipients: validatedRecipients,
      errors,
    };
  }

  async checkBalance(
    senderAddress: string,
    tokenAddress: string,
    requiredAmount: bigint,
  ) {
    try {
      const result = await this.blockchainService.getBalance(
        senderAddress,
        tokenAddress,
      );
      const balance = BigInt(result.balance);
      return {
        sufficient: balance >= requiredAmount,
        balance: balance.toString(),
        required: requiredAmount.toString(),
      };
    } catch (error) {
      this.logger.warn(
        `Balance check failed for ${senderAddress}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        sufficient: true,
        balance: '0',
        required: requiredAmount.toString(),
      };
    }
  }

  private parseAmountToUnits(value: string, decimals: number): bigint {
    const normalized = value.trim();
    if (!normalized) return 0n;
    try {
      const [whole, fraction = ''] = normalized.split('.');
      return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
    } catch {
      return 0n;
    }
  }

  private getRecipientAddressValue(
    recipient: Record<string, unknown>,
  ): string | undefined {
    if (typeof recipient.address === 'string') return recipient.address;
    if (typeof recipient.recipientAddress === 'string')
      return recipient.recipientAddress;
    return undefined;
  }
}
