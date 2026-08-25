import type { BridgeTestnetCode } from "@wizpay/bridge-registry";
import type { Address, Hex } from "viem";
import { backendFetch } from "./backend-api";

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

export interface BridgeIntentResponse {
  operationId: string;
  taskId: string;
  status: BridgeLifecycleStatus;
  intent: {
    sourceCode: BridgeTestnetCode;
    destinationCode: BridgeTestnetCode;
    sourceChainId: number;
    destinationChainId: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceUsdcAddress: Address;
    destinationUsdcAddress: Address;
    sourceTokenMessengerV2: Address;
    destinationTokenMessengerV2: Address;
    destinationMessageTransmitterV2: Address;
    walletAddress: Address;
    recipientAddress: Address;
    destinationCaller: Address;
    amount: string;
    maxFee: string;
    minFinalityThreshold: 2000;
  };
  result: {
    approvalTransactionHash?: Hex;
    sourceTransactionHash?: Hex;
    destinationTransactionHash?: Hex;
    messageHash?: Hex;
    nonce?: Hex;
    feeExecuted?: string;
    mintAmount?: string;
    expirationBlock?: string;
    completedAt?: string;
    attestedMessage?: Hex;
    attestation?: Hex;
  };
  destinationState?: "not_ready" | "available" | "received" | "unknown";
  leaseId?: string;
  attestationStatus?: string;
  message?: Hex;
  attestation?: Hex;
  createdAt: string;
  updatedAt: string;
}

export function createBridgeIntent(input: {
  idempotencyKey: string;
  sourceCode: BridgeTestnetCode;
  destinationCode: BridgeTestnetCode;
  walletAddress: Address;
  recipientAddress: Address;
  amount: string;
  maxFee: string;
  minFinalityThreshold: 2000;
}) {
  return backendFetch<BridgeIntentResponse>("/bridge/intents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getBridgeIntent(operationId: string, walletAddress: Address) {
  const query = new URLSearchParams({ walletAddress });
  return backendFetch<BridgeIntentResponse>(
    `/bridge/intents/${operationId}?${query.toString()}`,
  );
}

function report(
  operationId: string,
  stage:
    | "approval"
    | "source"
    | "attestation"
    | "reattest"
    | "destination"
    | "destination/authorize"
    | "destination/submitted"
    | "destination/verify",
  body: Record<string, unknown>,
) {
  return backendFetch<BridgeIntentResponse>(
    `/bridge/intents/${operationId}/${stage}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export const reportBridgeApproval = (
  operationId: string,
  walletAddress: Address,
  transactionHash: Hex,
) => report(operationId, "approval", { walletAddress, transactionHash });

export const reportBridgeSource = (
  operationId: string,
  walletAddress: Address,
  transactionHash: Hex,
) => report(operationId, "source", { walletAddress, transactionHash });

export const getBridgeAttestation = (
  operationId: string,
  walletAddress: Address,
) => report(operationId, "attestation", { walletAddress });

export const requestBridgeReattestation = (
  operationId: string,
  walletAddress: Address,
) => report(operationId, "reattest", { walletAddress });

export const reportBridgeDestination = (
  operationId: string,
  walletAddress: Address,
  transactionHash: Hex,
  messageHash: Hex,
) =>
  report(operationId, "destination", {
    walletAddress,
    transactionHash,
    messageHash,
  });

export const authorizeBridgeDestination = (
  operationId: string,
  walletAddress: Address,
) => report(operationId, "destination/authorize", { walletAddress });

export const submitBridgeDestination = (
  operationId: string,
  walletAddress: Address,
  leaseId: string,
  transactionHash: Hex,
  messageHash: Hex,
) =>
  report(operationId, "destination/submitted", {
    walletAddress,
    leaseId,
    transactionHash,
    messageHash,
  });

export const verifyBridgeDestination = (
  operationId: string,
  walletAddress: Address,
) => report(operationId, "destination/verify", { walletAddress });
