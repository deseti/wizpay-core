import { backendFetch } from "@/lib/backend-api";

function invoiceApiPath(path: string) {
  const prefix =
    process.env.NEXT_PUBLIC_INVOICE_API_PREFIX?.trim().replace(/\/$/, "") ||
    "";
  return `${prefix}${path}`;
}

export type InvoiceStatus =
  | "OPEN"
  | "VERIFYING"
  | "PAID"
  | "EXPIRED"
  | "CANCELLED";
export type InvoicePaymentStatus =
  | "SUBMITTED"
  | "VERIFYING"
  | "VERIFIED"
  | "REJECTED"
  | null;
export type InvoiceToken = {
  symbol: "USDC" | "EURC";
  name: string;
  address: `0x${string}`;
  decimals: number;
};

export type PublicInvoice = {
  publicId: string;
  merchantDisplayLabel: string | null;
  receivingAddress: `0x${string}`;
  receivingAddressShort: string;
  chain: { id: number; name: string };
  token: InvoiceToken;
  amount: string;
  amountUnits: string;
  title: string;
  description: string | null;
  expiresAt: string | null;
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  verificationCode: string | null;
  transactionHash: `0x${string}` | null;
  paidAt: string | null;
};

export type MerchantInvoice = PublicInvoice & {
  id: string;
  invoiceNumber: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  payerAddress: `0x${string}` | null;
};

export type CreateInvoiceInput = {
  token: "USDC" | "EURC";
  amount: string;
  title: string;
  description?: string;
  invoiceNumber?: string;
  expiresAt?: string;
};

function authHeaders(userToken: string) {
  return { Authorization: `Bearer ${userToken}` };
}

export function createInvoice(input: CreateInvoiceInput, userToken: string) {
  return backendFetch<MerchantInvoice>(invoiceApiPath("/invoices"), {
    method: "POST",
    headers: authHeaders(userToken),
    body: JSON.stringify(input),
  });
}

export function listInvoices(
  userToken: string,
  options: { status?: InvoiceStatus; limit?: number; offset?: number } = {},
) {
  const query = new URLSearchParams();
  if (options.status) query.set("status", options.status);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.offset !== undefined) query.set("offset", String(options.offset));
  return backendFetch<{
    items: MerchantInvoice[];
    total: number;
    limit: number;
    offset: number;
  }>(invoiceApiPath(`/invoices?${query}`), { headers: authHeaders(userToken) });
}

export function getMerchantInvoice(id: string, userToken: string) {
  return backendFetch<MerchantInvoice>(invoiceApiPath(`/invoices/${encodeURIComponent(id)}`), {
    headers: authHeaders(userToken),
  });
}

export function cancelInvoice(id: string, userToken: string) {
  return backendFetch<MerchantInvoice>(
    invoiceApiPath(`/invoices/${encodeURIComponent(id)}/cancel`),
    { method: "POST", headers: authHeaders(userToken) },
  );
}

export function getPublicInvoice(publicId: string, signal?: AbortSignal) {
  return backendFetch<PublicInvoice>(
    invoiceApiPath(`/public/invoices/${encodeURIComponent(publicId)}`),
    { signal },
  );
}

export function verifyPublicInvoicePayment(
  publicId: string,
  transactionHash: string,
  signal?: AbortSignal,
) {
  return backendFetch<PublicInvoice>(
    invoiceApiPath(`/public/invoices/${encodeURIComponent(publicId)}/payments/verify`),
    {
      method: "POST",
      body: JSON.stringify({ transactionHash }),
      signal,
    },
  );
}
