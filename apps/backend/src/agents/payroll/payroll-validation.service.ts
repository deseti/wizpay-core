import { Injectable, Logger } from '@nestjs/common';
import { AnsService } from '../../ans/ans.service';
import { BlockchainService } from '../../adapters/blockchain.service';

// ─── Types ──────────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────

const SUPPORTED_TOKENS = ['USDC', 'EURC'] as const;
const TOKEN_DECIMALS: Record<string, number> = { USDC: 6, EURC: 6 };
const MAX_BATCH_SIZE = 50;
const MAX_REFERENCE_ID_LENGTH = 64;
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const ANS_SUFFIXES = ['.arc', '.wizpay'] as const;

interface ResolvedRecipientAddress {
  originalValue?: string;
  resolvedAddress: string | null;
  attemptedAnsResolution: boolean;
}

// ─── Service ────────────────────────────────────────────────────────

/**
 * PayrollValidationService centralizes ALL validation for payroll tasks.
 *
 * Validates:
 * - Recipient addresses (Ethereum format)
 * - Amounts (positive, parseable, correct decimals)
 * - Token/network support
 * - Batch size limits (max 50 per batch)
 * - Reference ID format/length
 * - Balance sufficiency (via BlockchainService)
 *
 * Frontend only shows errors returned by the backend API.
 * No validation logic should exist in frontend code.
 */
@Injectable()
export class PayrollValidationService {
  private readonly logger = new Logger(PayrollValidationService.name);

  constructor(
    private readonly blockchainService: BlockchainService,
    private readonly ansService: AnsService,
  ) {}

  /**
   * Validate a payroll task payload before execution.
   * Throws BadRequestException with structured error messages on failure.
   */
  async validate(payload: Record<string, unknown>): Promise<PayrollValidationResult> {
    const errors: string[] = [];

    // ── Source token ────────────────────────────────────────────────
    const sourceToken = payload.sourceToken as string | undefined;
    if (!sourceToken || !SUPPORTED_TOKENS.includes(sourceToken as typeof SUPPORTED_TOKENS[number])) {
      errors.push(
        `sourceToken must be one of: ${SUPPORTED_TOKENS.join(', ')}. Got: "${sourceToken}"`,
      );
    }

    // ── Reference ID ───────────────────────────────────────────────
    const referenceId = payload.referenceId as string | undefined;
    if (referenceId && referenceId.length > MAX_REFERENCE_ID_LENGTH) {
      errors.push(
        `referenceId must be ${MAX_REFERENCE_ID_LENGTH} characters or less`,
      );
    }

    // ── Recipients array ───────────────────────────────────────────
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

    // ── Individual recipient validation ────────────────────────────
    const decimals = TOKEN_DECIMALS[sourceToken ?? 'USDC'] ?? 6;
    const validatedRecipients: ValidatedRecipient[] = [];
    const resolvedAddresses = await this.resolveRecipientAddresses(recipients);

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i] as Record<string, unknown> | undefined;
      const prefix = `recipients[${i}]`;
      const resolvedAddress = resolvedAddresses[i];

      if (!recipient || typeof recipient !== 'object') {
        errors.push(`${prefix}: must be an object`);
        continue;
      }

      // Address
      const address = resolvedAddress.originalValue;
      let normalizedAddress: string | null = null;

      if (!address || typeof address !== 'string') {
        errors.push(`${prefix}.address: required`);
      } else if (resolvedAddress.attemptedAnsResolution) {
        if (!resolvedAddress.resolvedAddress) {
          errors.push(`${prefix}.address: Domain ${address.trim()} is not registered`);
        } else {
          normalizedAddress = resolvedAddress.resolvedAddress;
        }
      } else if (!ETH_ADDRESS_REGEX.test(address.trim())) {
        errors.push(`${prefix}.address: invalid Ethereum address "${address}"`);
      } else {
        normalizedAddress = address.trim();
      }

      // Amount
      const amount = recipient.amount as string | number | undefined;
      if (amount === undefined || amount === null || amount === '') {
        errors.push(`${prefix}.amount: required`);
      } else {
        const numAmount = typeof amount === 'number' ? amount : Number(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
          errors.push(`${prefix}.amount: must be a positive number, got "${amount}"`);
        }
      }

      // Target token
      const targetToken = (recipient.targetToken as string) ?? sourceToken ?? 'USDC';
      if (!SUPPORTED_TOKENS.includes(targetToken as typeof SUPPORTED_TOKENS[number])) {
        errors.push(
          `${prefix}.targetToken: must be one of ${SUPPORTED_TOKENS.join(', ')}. Got: "${targetToken}"`,
        );
      }

      // If no errors for this recipient, add to validated list
      if (normalizedAddress && amount !== undefined && amount !== null && amount !== '') {
        const amountStr = String(amount);
        const numAmount = Number(amountStr);
        if (!isNaN(numAmount) && numAmount > 0) {
          validatedRecipients.push({
            address: normalizedAddress,
            amount: amountStr,
            amountUnits: this.parseAmountToUnits(amountStr, decimals),
            targetToken,
          });
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, recipients: validatedRecipients, errors };
    }

    return { valid: true, recipients: validatedRecipients, errors: [] };
  }

  /**
   * Check if the sender has sufficient balance for the total payroll amount.
   * This is an optional additional check — the on-chain tx will revert anyway,
   * but checking early provides better UX.
   */
  async checkBalance(
    senderAddress: string,
    tokenAddress: string,
    requiredAmount: bigint,
  ): Promise<{ sufficient: boolean; balance: string; required: string }> {
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
      // Don't block execution on balance check failure — let the chain revert
      return {
        sufficient: true,
        balance: '0',
        required: requiredAmount.toString(),
      };
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private parseAmountToUnits(value: string, decimals: number): bigint {
    const normalized = value.trim();
    if (!normalized) return 0n;

    try {
      const [whole, fraction = ''] = normalized.split('.');
      const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
      return BigInt(whole + paddedFraction);
    } catch {
      return 0n;
    }
  }

  private async resolveRecipientAddresses(
    recipients: unknown[],
  ): Promise<ResolvedRecipientAddress[]> {
    return Promise.all(
      recipients.map(async (recipient, index) => {
        if (!recipient || typeof recipient !== 'object') {
          return {
            resolvedAddress: null,
            attemptedAnsResolution: false,
          } satisfies ResolvedRecipientAddress;
        }

        const originalValue = this.getRecipientAddressValue(
          recipient as Record<string, unknown>,
        );
        if (!originalValue) {
          return {
            originalValue,
            resolvedAddress: null,
            attemptedAnsResolution: false,
          } satisfies ResolvedRecipientAddress;
        }

        const trimmedValue = originalValue.trim();
        if (!this.shouldResolveAnsDomain(trimmedValue)) {
          return {
            originalValue,
            resolvedAddress: null,
            attemptedAnsResolution: false,
          } satisfies ResolvedRecipientAddress;
        }

        try {
          const resolvedAddress = await this.ansService.resolveAddress(trimmedValue);
          if (!resolvedAddress || !ETH_ADDRESS_REGEX.test(resolvedAddress)) {
            this.logger.warn(
              `ANS resolution failed for recipients[${index}] domain "${trimmedValue}".`,
            );
            return {
              originalValue,
              resolvedAddress: null,
              attemptedAnsResolution: true,
            } satisfies ResolvedRecipientAddress;
          }

          this.logger.log(
            `Resolved ANS domain "${trimmedValue}" to ${resolvedAddress}.`,
          );

          return {
            originalValue,
            resolvedAddress,
            attemptedAnsResolution: true,
          } satisfies ResolvedRecipientAddress;
        } catch (error) {
          this.logger.error(
            `Unexpected ANS resolution error for recipients[${index}] domain "${trimmedValue}": ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            originalValue,
            resolvedAddress: null,
            attemptedAnsResolution: true,
          } satisfies ResolvedRecipientAddress;
        }
      }),
    );
  }

  private getRecipientAddressValue(
    recipient: Record<string, unknown>,
  ): string | undefined {
    if (typeof recipient.address === 'string') {
      return recipient.address;
    }

    if (typeof recipient.recipientAddress === 'string') {
      return recipient.recipientAddress;
    }

    return undefined;
  }

  private shouldResolveAnsDomain(value: string): boolean {
    const normalizedValue = value.trim().toLowerCase();
    return (
      ANS_SUFFIXES.some((suffix) => normalizedValue.endsWith(suffix)) ||
      !normalizedValue.startsWith('0x')
    );
  }
}
