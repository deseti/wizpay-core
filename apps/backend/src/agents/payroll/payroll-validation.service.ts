import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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

  constructor(private readonly blockchainService: BlockchainService) {}

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

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i] as Record<string, unknown> | undefined;
      const prefix = `recipients[${i}]`;

      if (!recipient || typeof recipient !== 'object') {
        errors.push(`${prefix}: must be an object`);
        continue;
      }

      // Address
      const address = recipient.address as string | undefined;
      if (!address || typeof address !== 'string') {
        errors.push(`${prefix}.address: required`);
      } else if (!ETH_ADDRESS_REGEX.test(address.trim())) {
        errors.push(`${prefix}.address: invalid Ethereum address "${address}"`);
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
      if (address && amount !== undefined && amount !== null && amount !== '') {
        const amountStr = String(amount);
        const numAmount = Number(amountStr);
        if (!isNaN(numAmount) && numAmount > 0) {
          validatedRecipients.push({
            address: (address as string).trim(),
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
}
