import { getAddress, type Address } from 'viem';

export const INVOICE_CHAIN_ID = 5_042_002;
export const INVOICE_CHAIN_NAME = 'Arc Testnet';
export const INVOICE_MAX_AMOUNT_UNITS = 1_000_000_000_000_000n;
export const INVOICE_PUBLIC_ID_BYTES = 16;

export const INVOICE_TOKENS = {
  USDC: {
    address: getAddress('0x3600000000000000000000000000000000000000'),
    decimals: 6,
    name: 'USD Coin',
    symbol: 'USDC',
  },
  EURC: {
    address: getAddress('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'),
    decimals: 6,
    name: 'Euro Coin',
    symbol: 'EURC',
  },
} as const satisfies Record<
  string,
  { address: Address; decimals: number; name: string; symbol: string }
>;

export type InvoiceTokenSymbol = keyof typeof INVOICE_TOKENS;

export const INVOICE_ERROR_CODES = {
  AUTH_REQUIRED: 'INVOICE_AUTH_REQUIRED',
  AUTH_INVALID: 'INVOICE_AUTH_INVALID',
  AUTH_IDENTITY_MISSING: 'INVOICE_AUTH_IDENTITY_MISSING',
  WALLET_MISSING: 'INVOICE_ARC_WALLET_MISSING',
  WALLET_CONFLICT: 'INVOICE_WALLET_CONFLICT',
  WALLET_OWNERSHIP_UNPROVEN: 'INVOICE_WALLET_OWNERSHIP_UNPROVEN',
  NOT_FOUND: 'INVOICE_NOT_FOUND',
  NOT_OPEN: 'INVOICE_NOT_OPEN',
  EXPIRED: 'INVOICE_EXPIRED',
  CANCELLED: 'INVOICE_CANCELLED',
  ALREADY_PAID: 'INVOICE_ALREADY_PAID',
  HASH_REUSED: 'INVOICE_TRANSACTION_HASH_REUSED',
  PAYMENT_ALREADY_SUBMITTED: 'INVOICE_PAYMENT_ALREADY_SUBMITTED',
  SELF_PAYMENT: 'INVOICE_SELF_PAYMENT',
  RATE_LIMITED: 'INVOICE_VERIFY_RATE_LIMITED',
  RPC_UNAVAILABLE: 'INVOICE_RPC_UNAVAILABLE',
  TRANSACTION_PENDING: 'INVOICE_TRANSACTION_PENDING',
  RECEIPT_PENDING: 'INVOICE_RECEIPT_PENDING',
  CONFIRMATIONS_PENDING: 'INVOICE_CONFIRMATIONS_PENDING',
  WRONG_CHAIN: 'INVOICE_WRONG_CHAIN',
  FAILED_RECEIPT: 'INVOICE_FAILED_RECEIPT',
  WRONG_SENDER: 'INVOICE_WRONG_SENDER',
  WRONG_TOKEN: 'INVOICE_WRONG_TOKEN',
  WRONG_RECIPIENT: 'INVOICE_WRONG_RECIPIENT',
  WRONG_AMOUNT: 'INVOICE_WRONG_AMOUNT',
  NATIVE_VALUE: 'INVOICE_NATIVE_VALUE_NOT_ZERO',
  MALFORMED_CALLDATA: 'INVOICE_MALFORMED_CALLDATA',
  TRANSFER_EVENT_MISSING: 'INVOICE_TRANSFER_EVENT_MISSING',
} as const;

export type InvoiceVerificationCode =
  (typeof INVOICE_ERROR_CODES)[keyof typeof INVOICE_ERROR_CODES];

export class InvoiceVerificationError extends Error {
  constructor(
    public readonly code: InvoiceVerificationCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'InvoiceVerificationError';
  }
}

export type InvoiceMerchantPrincipal = {
  merchantUserId: string;
  merchantWalletAddress: Address;
  merchantDisplayLabel: string | null;
};
