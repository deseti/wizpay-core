import {
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import { ERC20_ABI } from "@/constants/erc20";
import type { LoginMethod } from "@/services/circle-auth.types";

export const INVOICE_PAYMENT_RECOVERY_PREFIX = "wizpay.invoice-payment.v1.";
export type ExternalInvoicePaymentRecovery = {
  method: "external";
  publicId: string;
  transactionHash: Hex;
  createdAt: string;
};
export type AppWalletInvoicePaymentRecovery = {
  version: 2;
  method: "app";
  publicId: string;
  authMethod: LoginMethod;
  walletId: string;
  payerAddress: Address;
  challengeId: string;
  transactionId?: string;
  transactionHash?: Hex;
  createdAt: string;
  stage:
    | "awaiting_user_authorization"
    | "authorization_completed"
    | "resolving_transaction"
    | "confirming_onchain";
};
export type InvoicePaymentRecovery =
  | ExternalInvoicePaymentRecovery
  | AppWalletInvoicePaymentRecovery;

export function buildInvoiceTransferRequest(input: {
  chainId: number;
  tokenAddress: Address;
  recipient: Address;
  amountUnits: string;
}) {
  return {
    abi: ERC20_ABI,
    address: getAddress(input.tokenAddress),
    functionName: "transfer" as const,
    args: [getAddress(input.recipient), BigInt(input.amountUnits)] as const,
    chainId: input.chainId,
  };
}

export function isInvoiceSelfPayment(payer: Address, recipient: Address) {
  return isAddressEqual(getAddress(payer), getAddress(recipient));
}

export function readInvoicePaymentRecovery(
  publicId: string,
  storage?: Storage,
): InvoicePaymentRecovery | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(
      storage.getItem(`${INVOICE_PAYMENT_RECOVERY_PREFIX}${publicId}`) ||
        "null",
    ) as Record<string, unknown> | null;
    if (!value || !validBaseRecovery(value, publicId)) return null;

    if (value.method === "app") {
      if (
        value.version !== 2 ||
        !["email", "google", "passkey"].includes(String(value.authMethod)) ||
        typeof value.walletId !== "string" ||
        !value.walletId ||
        typeof value.challengeId !== "string" ||
        !value.challengeId ||
        !isAddress(String(value.payerAddress ?? "")) ||
        ![
          "awaiting_user_authorization",
          "authorization_completed",
          "resolving_transaction",
          "confirming_onchain",
        ].includes(String(value.stage)) ||
        (value.transactionId !== undefined &&
          (typeof value.transactionId !== "string" || !value.transactionId)) ||
        (value.transactionHash !== undefined &&
          !isTransactionHash(value.transactionHash))
      )
        return null;
      return {
        ...(value as unknown as AppWalletInvoicePaymentRecovery),
        payerAddress: getAddress(String(value.payerAddress)),
      };
    }

    // Records created before dual payer support intentionally had no method.
    if (!isTransactionHash(value.transactionHash)) return null;
    return {
      method: "external",
      publicId,
      transactionHash: value.transactionHash,
      createdAt: String(value.createdAt),
    };
  } catch {
    return null;
  }
}

export function writeInvoicePaymentRecovery(
  recovery: InvoicePaymentRecovery,
  storage?: Storage,
) {
  storage?.setItem(
    `${INVOICE_PAYMENT_RECOVERY_PREFIX}${recovery.publicId}`,
    JSON.stringify(recovery),
  );
}

export function clearInvoicePaymentRecovery(
  publicId: string,
  storage?: Storage,
) {
  storage?.removeItem(`${INVOICE_PAYMENT_RECOVERY_PREFIX}${publicId}`);
}

function validBaseRecovery(
  value: Record<string, unknown>,
  publicId: string,
) {
  return Boolean(
    value.publicId === publicId &&
      typeof value.createdAt === "string" &&
      Number.isFinite(Date.parse(value.createdAt)),
  );
}

function isTransactionHash(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}
