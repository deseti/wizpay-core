import { backendFetch } from "@/lib/backend-api";

export type ExecutionIntent = {
  id: string;
  idempotencyKey: string;
  status: string;
  circleChallengeId: string | null;
  circleTransactionId: string | null;
  transactionHash: `0x${string}` | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
};

export function acquireExecutionIntent(input: {
  network: "arc-testnet" | "arc-mainnet";
  operation:
    | "SEND"
    | "PAYROLL"
    | "TOKEN_APPROVAL"
    | "INVOICE_SETTLEMENT"
    | "PAYMENT_LINK_SETTLEMENT";
  sourceWallet: string;
  recipient?: string;
  batchDigest?: string;
  tokenIn: string;
  tokenOut: string;
  amountUnits: string;
  externalReference: string;
}) {
  return backendFetch<ExecutionIntent>("/execution-intents/acquire", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function bindExecutionIntentTransactionHash(
  intentId: string,
  transactionHash: string,
  idempotencyKey: string,
  leaseOwner?: string,
) {
  return backendFetch<ExecutionIntent>(
    `/execution-intents/${encodeURIComponent(intentId)}/transaction-hash`,
    {
      method: "POST",
      body: JSON.stringify({ transactionHash, idempotencyKey, leaseOwner }),
    },
  );
}

export function prepareWalletExecutionIntent(
  intentId: string,
  idempotencyKey: string,
  leaseOwner: string,
) {
  return backendFetch<ExecutionIntent>(
    `/execution-intents/${encodeURIComponent(intentId)}/prepare-wallet`,
    {
      method: "POST",
      body: JSON.stringify({ idempotencyKey, leaseOwner }),
    },
  );
}

export function recoverExecutionIntent(
  intentId: string,
  idempotencyKey: string,
) {
  return backendFetch<ExecutionIntent>(
    `/execution-intents/${encodeURIComponent(intentId)}/recover`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );
}

export function bindKnownExecutionIntentHash(
  intentId: string,
  idempotencyKey: string,
  transactionHash: string,
) {
  return backendFetch<ExecutionIntent>(
    `/execution-intents/${encodeURIComponent(intentId)}/recover-hash`,
    {
      method: "POST",
      body: JSON.stringify({ idempotencyKey, transactionHash }),
    },
  );
}

export function cancelExecutionIntent(
  intentId: string,
  idempotencyKey: string,
) {
  return backendFetch<ExecutionIntent>(
    `/execution-intents/${encodeURIComponent(intentId)}/cancel`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );
}

export function verifyDirectExecutionIntent(
  intentId: string,
  idempotencyKey: string,
) {
  return backendFetch<ExecutionIntent>(
    `/execution-intents/${encodeURIComponent(intentId)}/verify`,
    { method: "POST", body: JSON.stringify({ idempotencyKey }) },
  );
}
