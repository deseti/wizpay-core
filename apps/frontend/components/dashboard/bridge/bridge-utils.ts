import type {
  CircleTransfer,
  CircleTransferBlockchain,
  CircleTransferStep,
  CircleTransferWallet,
} from "@/lib/transfer-service";
import { TransferApiError } from "@/lib/transfer-service";
import {
  BRIDGE_ASSET_SYMBOL,
  APP_TREASURY_WALLET_TITLE,
  APP_TREASURY_WALLET_LABEL,
  DESTINATION_OPTIONS,
  STEP_ORDER,
  type BridgeStepId,
} from "./bridge-types";

// ─── Route helpers ────────────────────────────────────────────────────────────

export function getOptionByChain(chain: CircleTransferBlockchain) {
  return (
    DESTINATION_OPTIONS.find((option) => option.id === chain) ??
    DESTINATION_OPTIONS[0]
  );
}

export function getDefaultDestinationBlockchain(
  sourceBlockchain: CircleTransferBlockchain
): CircleTransferBlockchain {
  return (
    DESTINATION_OPTIONS.find((option) => option.id !== sourceBlockchain)?.id ??
    "ARC-TESTNET"
  );
}

export function isSolanaChain(chain: CircleTransferBlockchain): boolean {
  return chain === "SOLANA-DEVNET";
}

export function isValidDestinationAddress(
  address: string,
  chain: CircleTransferBlockchain
): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  if (isSolanaChain(chain)) {
    return (
      trimmed.length >= 32 &&
      trimmed.length <= 44 &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)
    );
  }
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
}

export function getEstimatedBridgeTimeLabel(
  sourceBlockchain: CircleTransferBlockchain,
  isExternalBridge: boolean
) {
  if (sourceBlockchain === "ETH-SEPOLIA") {
    return isExternalBridge ? "10-30 minutes" : "5-15 minutes";
  }
  if (sourceBlockchain === "ARC-TESTNET") {
    return "2-8 minutes";
  }
  if (sourceBlockchain === "SOLANA-DEVNET") {
    return "2-10 minutes (requires a small SOL fee balance)";
  }
  return "5-15 minutes";
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export function normalizeBridgeStepId(
  value: string | undefined
): BridgeStepId | null {
  if (value === "burn" || value === "attestation" || value === "mint") {
    return value;
  }
  return null;
}

export function isTrackedTransfer(
  transfer: CircleTransfer | null
): transfer is CircleTransfer {
  return Boolean(
    transfer &&
      (transfer.status === "pending" || transfer.status === "processing")
  );
}

export function isPositiveDecimal(input: string) {
  if (!input.trim()) return false;
  return /^\d+(?:\.\d+)?$/.test(input) && Number(input) > 0;
}

export function isValidAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function hasExplorerTxHash(url: string | null | undefined) {
  if (!url) return false;
  return /\/tx\/(0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})(?:$|[/?#])/.test(
    url
  );
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function shortenAddress(address: string | null | undefined) {
  if (!address) return "Unavailable";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatWalletBalance(
  wallet: CircleTransferWallet | null,
  tokenSymbol: string
) {
  if (!wallet?.balance) return `0 ${tokenSymbol}`;
  return `${wallet.balance.amount} ${wallet.balance.symbol || tokenSymbol}`;
}

export function getLastUpdatedLabel(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

// ─── Error message helpers ────────────────────────────────────────────────────

export function getErrorDetails(error: TransferApiError | null) {
  if (!error?.details || typeof error.details !== "object") return null;
  return error.details as Record<string, unknown>;
}

export function getTreasuryFundingMessage({
  networkLabel,
  availableAmount,
  symbol,
  walletAddress,
  requestedAmount,
}: {
  networkLabel: string;
  availableAmount: string;
  symbol: string;
  walletAddress?: string | null;
  requestedAmount?: string;
}) {
  const walletReference = walletAddress
    ? `${APP_TREASURY_WALLET_TITLE} ${shortenAddress(walletAddress)}`
    : `The ${APP_TREASURY_WALLET_LABEL}`;

  return `Bridge requires ${BRIDGE_ASSET_SYMBOL} in the ${APP_TREASURY_WALLET_LABEL}. ${walletReference} currently holds ${availableAmount} ${symbol} on ${networkLabel}. Please fund this wallet${requestedAmount ? ` before bridging ${requestedAmount} ${BRIDGE_ASSET_SYMBOL}` : " before bridging"}.`;
}

export function getTreasurySetupMessage(networkLabel: string) {
  return `Bridge requires an ${APP_TREASURY_WALLET_LABEL} on ${networkLabel}. Initialize it below, then fund it with ${BRIDGE_ASSET_SYMBOL} before bridging.`;
}

export function getBridgeErrorMessage(
  error: unknown,
  labels: { destinationLabel: string; sourceLabel: string }
) {
  const transferError = error instanceof TransferApiError ? error : null;
  const details = getErrorDetails(transferError);
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  if (transferError?.code === "CIRCLE_WALLET_NOT_FOUND") {
    const walletSetCount = Array.isArray(details?.walletSetIds)
      ? details.walletSetIds.length
      : 0;
    if (walletSetCount > 0) {
      return `Circle can see ${walletSetCount} wallet set${walletSetCount === 1 ? "" : "s"}, but none contains a ${labels.sourceLabel} ${APP_TREASURY_WALLET_LABEL} yet. Initialize the treasury wallet and fund it with ${BRIDGE_ASSET_SYMBOL} before retrying.`;
    }
    return `No ${labels.sourceLabel} ${APP_TREASURY_WALLET_LABEL} is ready yet. Initialize it below and fund it with ${BRIDGE_ASSET_SYMBOL} before retrying.`;
  }

  if (transferError?.code === "CIRCLE_WALLET_CONFIG_MISSING") {
    return `No ${labels.sourceLabel} ${APP_TREASURY_WALLET_LABEL} is configured yet. Initialize one below or set the server treasury wallet environment variables before retrying.`;
  }

  if (
    transferError?.code === "CIRCLE_WALLET_ID_MISMATCH" ||
    transferError?.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
    transferError?.code === "CIRCLE_BRIDGE_SOURCE_WALLET_CHAIN_MISMATCH"
  ) {
    return `The configured ${labels.sourceLabel} ${APP_TREASURY_WALLET_LABEL} does not match the selected route. Update the per-chain Circle wallet mapping before retrying.`;
  }

  if (transferError?.code === "CIRCLE_BRIDGE_SAME_CHAIN") {
    return "Bridge source and destination must be different networks.";
  }

  if (
    transferError?.code === "CIRCLE_ENTITY_SECRET_INVALID" ||
    transferError?.code === "CIRCLE_ENTITY_SECRET_NOT_REGISTERED" ||
    transferError?.code === "CIRCLE_ENTITY_SECRET_ROTATED"
  ) {
    return "The server can read Circle wallet sets, but signed write calls are being rejected. This usually means CIRCLE_ENTITY_SECRET does not match the Circle entity or project behind the current API key, or the secret was pasted with extra whitespace.";
  }

  if (transferError?.code === "CIRCLE_ENTITY_SECRET_FORMAT_INVALID") {
    return "The configured CIRCLE_ENTITY_SECRET is not the raw 64-character secret required by the official Circle Bridge Kit flow. Replace it with the original entity secret, not the recovery file contents or encrypted ciphertext, then restart the server.";
  }

  if (transferError?.code === "CIRCLE_BRIDGE_USDC_ONLY") {
    return "This bridge currently supports USDC only. EURC is intentionally unavailable in this flow.";
  }

  if (transferError?.code === "CIRCLE_BRIDGE_FORWARDER_UNAVAILABLE") {
    return `Circle Forwarder is not available for the ${labels.sourceLabel} to ${labels.destinationLabel} route right now. Retry later or use a different supported pair.`;
  }

  if (transferError?.code === "CIRCLE_BRIDGE_NOT_FOUND") {
    return "The last bridge session is no longer available on this server. Start a new bridge to resume live tracking.";
  }

  if (transferError?.code === "CIRCLE_BRIDGE_STORAGE_UNAVAILABLE") {
    return "Live bridge tracking is temporarily unavailable because Redis could not be read. The last known progress stays on screen and the bridge may still continue on-chain.";
  }

  if (transferError?.code === "CIRCLE_BRIDGE_REDIS_CONFIG_MISSING") {
    return "Live bridge tracking is unavailable because Redis is not configured on the server. The bridge may still continue on-chain, but automatic status updates are disabled.";
  }

  if (transferError?.code === "CIRCLE_BRIDGE_EXECUTION_FAILED") {
    const failedStep =
      details &&
      typeof details === "object" &&
      details.failedStep &&
      typeof details.failedStep === "object"
        ? (details.failedStep as Record<string, unknown>)
        : null;
    const failedStepName =
      failedStep && typeof failedStep.name === "string"
        ? failedStep.name
        : null;
    const failedStepMessage =
      failedStep && typeof failedStep.errorMessage === "string"
        ? failedStep.errorMessage
        : null;
    if (failedStepName && failedStepMessage) {
      return `Circle Bridge Kit failed during ${failedStepName}: ${failedStepMessage}`;
    }
    return `Circle Bridge Kit could not finish the ${labels.sourceLabel} to ${labels.destinationLabel} bridge.`;
  }

  if (transferError?.code === "CIRCLE_SCA_WALLET_CREATION_DISABLED") {
    return `Circle accepted the server credentials, but this account cannot create an SCA wallet on ${labels.sourceLabel} yet. Enable the required paymaster or SCA wallet policy in Circle before bootstrapping this chain.`;
  }

  if (
    transferError?.code === "CIRCLE_API_KEY_BLOCKCHAIN_MISMATCH" ||
    transferError?.code === "CIRCLE_TRANSFER_BLOCKCHAIN_INVALID"
  ) {
    return `Circle rejected the ${labels.sourceLabel} to ${labels.destinationLabel} bridge configuration. Check the selected chain pair and the server-side Circle API key setup before retrying.`;
  }

  if (transferError?.code === "CIRCLE_TRANSFER_INSUFFICIENT_BALANCE") {
    const walletAddress =
      typeof details?.walletAddress === "string" ? details.walletAddress : null;
    const availableAmount =
      typeof details?.availableAmount === "string"
        ? details.availableAmount
        : "0";
    const symbol =
      typeof details?.symbol === "string" ? details.symbol : BRIDGE_ASSET_SYMBOL;
    return getTreasuryFundingMessage({
      networkLabel: labels.sourceLabel,
      availableAmount,
      symbol,
      walletAddress,
    });
  }

  if (
    transferError?.code === "CIRCLE_API_KEY_MISSING" ||
    transferError?.code === "CIRCLE_ENTITY_SECRET_MISSING"
  ) {
    return "The server is missing Circle treasury wallet credentials. Configure the developer-controlled wallet secrets before retrying this bridge flow.";
  }

  if (
    message.toLowerCase().includes("solana source treasury wallet needs devnet sol")
  ) {
    return "Solana source treasury wallet has insufficient SOL for network fees. Fund it with a small SOL amount on Devnet, then retry.";
  }

  if (
    message.includes("InstructionError") &&
    message.includes('Custom":1') &&
    message.toLowerCase().includes("network: devnet")
  ) {
    return "Solana source treasury wallet has insufficient SOL for network fees. Fund it with a small SOL amount on Devnet, then retry.";
  }

  if (message.includes("fetch failed")) {
    return "The bridge request could not reach the local app server. Reload the page and retry.";
  }

  if (
    message
      .toLowerCase()
      .includes("the asset amount owned by the wallet is insufficient for the transaction")
  ) {
    return `Your personal ${labels.sourceLabel} Circle wallet does not have enough USDC for this deposit confirmation. Fund the personal source wallet and retry. This error is not about treasury wallet balance.`;
  }

  if (message.toLowerCase().includes("apolloerror: forbidden")) {
    return "Circle rejected this request (Forbidden). Your session may be stale or your wallet challenge no longer valid. Re-login with Google and retry.";
  }

  return message;
}

// ─── Transfer step / status helpers ──────────────────────────────────────────

export function getOrderedBridgeSteps(
  transfer: CircleTransfer,
  sourceLabel: string,
  destinationLabel: string
): CircleTransferStep[] {
  return STEP_ORDER.map((stepId) => {
    const step = transfer.steps.find((candidate) => candidate.id === stepId);
    if (step) return step;
    return {
      id: stepId,
      name:
        stepId === "burn"
          ? `Burn on ${sourceLabel}`
          : stepId === "mint"
            ? `Mint on ${destinationLabel}`
            : "Waiting for Circle attestation",
      state: "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: null,
    };
  });
}

export function getCurrentStepId(
  transfer: CircleTransfer | null,
  steps: CircleTransferStep[]
): BridgeStepId | null {
  if (!transfer || steps.length === 0) return null;
  const failedStep = steps.find((step) => step.state === "error");
  if (failedStep) return normalizeBridgeStepId(failedStep.id);
  if (transfer.status === "settled") return "mint";
  const pendingStep = steps.find((step) => step.state === "pending");
  if (pendingStep) return normalizeBridgeStepId(pendingStep.id);
  const inFlightStep = steps.find(
    (step) => step.state !== "success" && step.state !== "noop"
  );
  if (inFlightStep) return normalizeBridgeStepId(inFlightStep.id);
  return normalizeBridgeStepId(steps[steps.length - 1]?.id);
}

export function getTransferHeadline(
  transfer: CircleTransfer,
  currentStepName: string | undefined
) {
  if (transfer.status === "settled") return "Bridge completed successfully";
  if (transfer.status === "failed") return "Bridge needs attention";
  if (transfer.rawStatus === "attested") return "Attestation received, mint is next";
  if (transfer.rawStatus === "burned") return "Burn confirmed, waiting for attestation";
  return currentStepName || "Bridge submitted";
}

export function getTransferStatusLabel(transfer: CircleTransfer) {
  if (transfer.status === "settled") return "Completed";
  if (transfer.status === "failed") return "Failed";
  if (transfer.rawStatus === "attested") return "Minting";
  if (transfer.rawStatus === "burned") return "Awaiting attestation";
  return transfer.status === "processing" ? "Processing" : "Queued";
}

export function getStatusBadgeClass(transfer: CircleTransfer) {
  if (transfer.status === "settled")
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  if (transfer.status === "failed")
    return "border-destructive/25 bg-destructive/10 text-destructive";
  if (transfer.rawStatus === "attested")
    return "border-primary/25 bg-primary/10 text-primary";
  return "border-amber-500/25 bg-amber-500/10 text-amber-300";
}

export function getStepStatusLabel(
  step: CircleTransferStep,
  currentStepId: BridgeStepId | null,
  transferStatus: CircleTransfer["status"]
) {
  const stepId = normalizeBridgeStepId(step.id);
  if (step.state === "success") return "Success";
  if (step.state === "error") return "Failed";
  if (transferStatus === "settled" && stepId === "mint") return "Success";
  if (currentStepId && stepId === currentStepId) return "In progress";
  return "Pending";
}

export function getLongRunningTransferMessage(
  transfer: CircleTransfer,
  currentStepId: BridgeStepId | null,
  labels: { destinationLabel: string; sourceLabel: string }
) {
  if (transfer.status === "pending" && transfer.rawStatus === "queued") {
    return "This bridge has stayed queued longer than expected. If the source wallet balance already changed, this is likely an older tracking record that stopped updating before the latest Redis fix.";
  }
  if (transfer.rawStatus === "attested" || currentStepId === "mint") {
    return `Circle attestation is done. Mint is pending on ${labels.destinationLabel}. This last step can still take a few more minutes on testnet.`;
  }
  if (transfer.rawStatus === "burned" || currentStepId === "attestation") {
    return `Burn is already confirmed on ${labels.sourceLabel}. Circle is now waiting to issue the CCTP attestation before minting on ${labels.destinationLabel}. Testnet attestation can take several minutes.`;
  }
  if (currentStepId === "burn") {
    return `The source-chain burn is still being finalized on ${labels.sourceLabel}. After that, Circle will wait for attestation and then mint on ${labels.destinationLabel}.`;
  }
  return "Still processing on-chain. You can check back later.";
}

export function recoverTerminalTransfer(
  transfer: CircleTransfer | null
): CircleTransfer | null {
  if (!transfer) return null;

  const allStepsSucceeded =
    transfer.steps.length > 0 &&
    transfer.steps.every(
      (step) => step.state === "success" || step.state === "noop"
    );

  if (allStepsSucceeded) {
    return {
      ...transfer,
      stage: "completed",
      status: "settled",
      rawStatus: "completed",
      errorReason: null,
    };
  }

  const failedStep = transfer.steps.find((step) => step.state === "error");
  if (failedStep || transfer.status === "failed") {
    return {
      ...transfer,
      stage: "failed",
      status: "failed",
      rawStatus: "failed",
      errorReason:
        transfer.errorReason || failedStep?.errorMessage || "Bridge failed",
    };
  }

  return null;
}
