import { backendFetch } from "@/lib/backend-api";

export type BridgeLifecycleStatus =
  | "idle"
  | "approving_source"
  | "approval_confirmed"
  | "source_approved"
  | "burning_source"
  | "source_confirmed"
  | "source_burn_confirmed"
  | "waiting_for_attestation"
  | "attestation_ready"
  | "switching_destination_chain"
  | "awaiting_destination_signature"
  | "minting_destination"
  | "verifying_destination"
  | "source_rejected"
  | "source_failed_before_burn"
  | "attestation_delayed"
  | "destination_signature_rejected"
  | "destination_transaction_failed"
  | "destination_verification_failed"
  | "configuration_error"
  | "completed";

export type BridgeTransferMode = "fast" | "standard";

export type BridgeQuote = Readonly<{
  sourceCode: string;
  destinationCode: string;
  transferMode: BridgeTransferMode;
  minFinalityThreshold: 1000 | 2000;
  amount: string;
  protocolFee: string;
  maxFeeSuggested: string;
  receiveAmount: string;
  allowanceSufficient: boolean | null;
}>;

export type BridgeIntentPayload = Readonly<{
  idempotencyKey: string;
  sourceCode: string;
  destinationCode: string;
  sourceChainId: number;
  destinationChainId: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceUsdcAddress: `0x${string}`;
  destinationUsdcAddress: `0x${string}`;
  sourceTokenMessengerV2: `0x${string}`;
  destinationTokenMessengerV2: `0x${string}`;
  destinationMessageTransmitterV2: `0x${string}`;
  walletAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  destinationCaller: `0x${string}`;
  amount: string;
  maxFee: string;
  minFinalityThreshold: 1000 | 2000;
  createdAt: string;
}>;

export type BridgeLifecycleResult = Readonly<{
  approvalTransactionHash?: `0x${string}`;
  sourceTransactionHash?: `0x${string}`;
  destinationTransactionHash?: `0x${string}`;
  messageHash?: `0x${string}`;
  nonce?: `0x${string}`;
  feeExecuted?: string;
  mintAmount?: string;
  expirationBlock?: string;
  attestedMessage?: `0x${string}`;
  attestation?: `0x${string}`;
  completedAt?: string;
  destinationSubmittedAt?: string;
  attestationStatus?: string;
  attestationDelayReason?: string | null;
}>;

export type BridgeIntentView = Readonly<{
  id: string;
  status: BridgeLifecycleStatus;
  payload: BridgeIntentPayload;
  result: BridgeLifecycleResult | null;
  createdAt: string;
  updatedAt: string;
  destinationLeaseId?: string;
}>;

function walletQuery(walletAddress: string) {
  return `?walletAddress=${encodeURIComponent(walletAddress)}`;
}

export function fetchBridgeQuote(input: {
  sourceCode: string;
  destinationCode: string;
  amount: string;
}) {
  const query =
    `?sourceCode=${encodeURIComponent(input.sourceCode)}` +
    `&destinationCode=${encodeURIComponent(input.destinationCode)}` +
    `&amount=${encodeURIComponent(input.amount)}`;
  return backendFetch<BridgeQuote>(`/bridge/quote${query}`);
}

export function createBridgeIntent(input: {
  idempotencyKey: string;
  sourceCode: string;
  destinationCode: string;
  walletAddress: string;
  recipientAddress: string;
  amount: string;
  maxFee: string;
  minFinalityThreshold: 1000 | 2000;
}) {
  return backendFetch<BridgeIntentView>("/bridge/intents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getBridgeIntent(id: string, walletAddress: string) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}${walletQuery(walletAddress)}`,
  );
}

export function reportBridgeApproval(
  id: string,
  input: { walletAddress: string; transactionHash: string },
) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}/approval`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function reportBridgeSource(
  id: string,
  input: { walletAddress: string; transactionHash: string },
) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}/source`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function getBridgeAttestation(id: string, walletAddress: string) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}/attestation`,
    {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    },
  );
}

export function authorizeBridgeDestination(
  id: string,
  walletAddress: string,
) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}/destination/authorize`,
    { method: "POST", body: JSON.stringify({ walletAddress }) },
  );
}

export function submitBridgeDestination(
  id: string,
  input: {
    walletAddress: string;
    transactionHash: string;
    messageHash: string;
    leaseId: string;
  },
) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}/destination/submitted`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function verifyBridgeDestination(id: string, walletAddress: string) {
  return backendFetch<BridgeIntentView>(
    `/bridge/intents/${encodeURIComponent(id)}/destination/verify`,
    { method: "POST", body: JSON.stringify({ walletAddress }) },
  );
}
