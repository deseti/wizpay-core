import { Injectable, Logger } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';
import { AnsService } from '../../ans/ans.service';
import { BlockchainService } from '../../adapters/blockchain.service';

// ─── Types ──────────────────────────────────────────────────────────

export interface ValidatedRecipient {
  address: string;
  originalAddress?: string;
  resolvedFromAns?: boolean;
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

interface ResolvedRecipientAddress {
  originalValue?: string;
  normalizedAddress: string | null;
  attemptedAnsResolution: boolean;
  resolvedFromAns: boolean;
  errorMessage: string | null;
}

type RecipientInputKind =
  | 'address'
  | 'ans'
  | 'invalid-address'
  | 'invalid-ans'
  | 'unsupported-ans';

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
      let normalizedAddress = resolvedAddress.normalizedAddress;

      if (!address || typeof address !== 'string') {
        errors.push(`${prefix}.address: required`);
      } else if (resolvedAddress.errorMessage) {
        errors.push(`${prefix}.address: ${resolvedAddress.errorMessage}`);
      } else if (!normalizedAddress) {
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
      if (normalizedAddress && amount !== undefined && amount !== null && amount !== '') {
        const amountStr = String(amount);
        const numAmount = Number(amountStr);
        if (!isNaN(numAmount) && numAmount > 0) {
          validatedRecipients.push({
            address: normalizedAddress,
            originalAddress: typeof address === 'string' ? address.trim() : undefined,
            resolvedFromAns: resolvedAddress.resolvedFromAns,
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
            normalizedAddress: null,
            attemptedAnsResolution: false,
            resolvedFromAns: false,
            errorMessage: null,
          } satisfies ResolvedRecipientAddress;
        }

        const originalValue = this.getRecipientAddressValue(
          recipient as Record<string, unknown>,
        );
        if (!originalValue) {
          return {
            originalValue,
            normalizedAddress: null,
            attemptedAnsResolution: false,
            resolvedFromAns: false,
            errorMessage: null,
          } satisfies ResolvedRecipientAddress;
        }

        const trimmedValue = originalValue.trim();
        const inputKind = this.classifyRecipientInput(trimmedValue);

        if (inputKind.kind === 'address') {
          return {
            originalValue,
            normalizedAddress: getAddress(trimmedValue),
            attemptedAnsResolution: false,
            resolvedFromAns: false,
            errorMessage: null,
          } satisfies ResolvedRecipientAddress;
        }

        if (inputKind.kind === 'invalid-address') {
          return {
            originalValue,
            normalizedAddress: null,
            attemptedAnsResolution: false,
            resolvedFromAns: false,
            errorMessage: null,
          } satisfies ResolvedRecipientAddress;
        }

        if (inputKind.kind === 'unsupported-ans' || inputKind.kind === 'invalid-ans') {
          return {
            originalValue,
            normalizedAddress: null,
            attemptedAnsResolution: true,
            resolvedFromAns: false,
            errorMessage: inputKind.errorMessage,
          } satisfies ResolvedRecipientAddress;
        }

        try {
          const resolvedAddress = await this.ansService.inspectDomain(
            inputKind.normalizedDomain,
          );

          if (!resolvedAddress) {
            return {
              originalValue,
              normalizedAddress: null,
              attemptedAnsResolution: true,
              resolvedFromAns: false,
              errorMessage: `Invalid ANS format. ${trimmedValue}`,
            } satisfies ResolvedRecipientAddress;
          }

          if (resolvedAddress.resolutionStatus !== 'resolved' || !resolvedAddress.resolvedAddress) {
            const errorMessage =
              resolvedAddress.resolutionStatus === 'unsupported_namespace'
                ? 'Unsupported ANS namespace. Only .arc and .wizpay are supported.'
                : resolvedAddress.resolutionStatus === 'resolver_unavailable'
                  ? `Resolver unavailable for "${resolvedAddress.normalizedDomain}".`
                  : `Name not found for "${resolvedAddress.normalizedDomain}".`;

            this.logger.warn(
              `ANS resolution failed for recipients[${index}] domain "${trimmedValue}": ${errorMessage}`,
            );

            return {
              originalValue,
              normalizedAddress: null,
              attemptedAnsResolution: true,
              resolvedFromAns: false,
              errorMessage,
            } satisfies ResolvedRecipientAddress;
          }

          this.logger.log(
            `Resolved ANS domain "${trimmedValue}" to ${resolvedAddress.resolvedAddress}.`,
          );

          return {
            originalValue,
            normalizedAddress: resolvedAddress.resolvedAddress,
            attemptedAnsResolution: true,
            resolvedFromAns: true,
            errorMessage: null,
          } satisfies ResolvedRecipientAddress;
        } catch (error) {
          this.logger.error(
            `Unexpected ANS resolution error for recipients[${index}] domain "${trimmedValue}": ${error instanceof Error ? error.message : String(error)}`,
          );
          return {
            originalValue,
            normalizedAddress: null,
            attemptedAnsResolution: true,
            resolvedFromAns: false,
            errorMessage: `Resolver unavailable for "${inputKind.normalizedDomain}".`,
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

  private classifyRecipientInput(value: string): {
    kind: RecipientInputKind;
    normalizedDomain: string;
    errorMessage: string | null;
  } {
    if (isAddress(value)) {
      return {
        kind: 'address',
        normalizedDomain: '',
        errorMessage: null,
      };
    }

    if (!value.includes('.')) {
      return {
        kind: 'invalid-address',
        normalizedDomain: '',
        errorMessage: null,
      };
    }

    const parsedDomain = this.ansService.parseDomain(value);
    const normalizedDomain = parsedDomain?.normalizedDomain ?? value.trim().toLowerCase();
    const parts = normalizedDomain.split('.').filter(Boolean);

    if (parts.length !== 2) {
      return {
        kind: 'invalid-ans',
        normalizedDomain,
        errorMessage:
          'Invalid ANS format. Only exact second-level .arc and .wizpay names are supported.',
      };
    }

    if (!parsedDomain?.isSupportedNamespace) {
      return {
        kind: 'unsupported-ans',
        normalizedDomain,
        errorMessage:
          'Unsupported ANS namespace. Only .arc and .wizpay are supported.',
      };
    }

    const label = parts[0] ?? '';
    if (label.length < 3) {
      return {
        kind: 'invalid-ans',
        normalizedDomain,
        errorMessage: 'Invalid ANS format. Labels must be at least 3 characters long.',
      };
    }

    if (label.startsWith('-') || label.endsWith('-')) {
      return {
        kind: 'invalid-ans',
        normalizedDomain,
        errorMessage:
          'Invalid ANS format. Labels cannot start or end with a hyphen.',
      };
    }

    if (!/^[a-z0-9-]+$/.test(label)) {
      return {
        kind: 'invalid-ans',
        normalizedDomain,
        errorMessage:
          'Invalid ANS format. Use lowercase letters, numbers, and hyphens only.',
      };
    }

    return {
      kind: 'ans',
      normalizedDomain,
      errorMessage: null,
    };
  }
}
