"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Droplet,
  ExternalLink,
  MessageCircle,
  RefreshCw,
  Route,
  Wallet,
} from "lucide-react";

import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { usePublicClient, useReadContract, useSwitchChain, useWalletClient } from "wagmi";

import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useHybridWallet } from "@/components/providers/HybridWalletProvider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ETHEREUM_SEPOLIA_USDC_ADDRESS,
  USDC_ADDRESS,
} from "@/constants/addresses";
import { useToast } from "@/hooks/use-toast";
import { useAdaptivePolling } from "@/hooks/useAdaptivePolling";
import {
  bootstrapCircleTransferWallet,
  createCircleTransfer,
  getCircleTransferStatus,
  getCircleTransferWallet,
  TransferApiError,
  type CircleTransfer,
  type CircleTransferBlockchain,
  type CircleTransferStep,
  type CircleTransferWallet,
} from "@/lib/transfer-service";
import {
  CCTP_ATTESTATION_POLL_INTERVAL_MS,
  CCTP_DOMAIN_BY_CHAIN,
  CCTP_ERC20_APPROVE_ABI,
  CCTP_MIN_FINALITY_FAST,
  CCTP_MESSAGE_TRANSMITTER_ABI,
  CCTP_TOKEN_MESSENGER_ABI,
  CCTP_USDC_DECIMALS,
  CCTP_V2_MESSAGE_TRANSMITTER,
  CCTP_V2_TOKEN_MESSENGER,
  CHAIN_ID_BY_BRIDGE_CHAIN,
  evmAddressToBytes32,
  extractMessageBytesFromLogs,
  getCctpExplorerUrl,
  pollCctpV2Attestation,
  ZERO_BYTES32,
} from "@/lib/cctp";
import { CHAIN_BY_ID } from "@/lib/wagmi";
import { ERC20_ABI } from "@/constants/erc20";

const TRANSFER_WALLET_STORAGE_KEY = "wizpay-bridge-transfer-wallets";
const ACTIVE_TRANSFER_STORAGE_KEY = "wizpay-bridge-active-transfer";
const BRIDGE_POLL_INTERVAL_MS = 4_000;
const BRIDGE_LONG_RUNNING_MS = 120_000;
// Transfers stuck in a non-terminal state longer than this are considered
// abandoned and will be auto-dismissed on restore or when detected in the UI.
const BRIDGE_STUCK_TIMEOUT_MS = 15 * 60 * 1_000; // 15 minutes
const STEP_ORDER = ["burn", "attestation", "mint"] as const;
const DEFAULT_SOURCE_BLOCKCHAIN: CircleTransferBlockchain = "ETH-SEPOLIA";

function getEstimatedBridgeTimeLabel(
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

type BridgeStepId = (typeof STEP_ORDER)[number];
type StoredTransferWallet = {
  walletId: string | null;
  walletAddress: string;
  walletSetId: string | null;
};
type StoredTransferWalletMap = Partial<
  Record<CircleTransferBlockchain, StoredTransferWallet>
>;

type DestinationWalletMap = Partial<
  Record<CircleTransferBlockchain, CircleTransferWallet | null>
>;

const DESTINATION_OPTIONS: Array<{
  id: CircleTransferBlockchain;
  label: string;
}> = [
  {
    id: "ARC-TESTNET",
    label: "Arc Testnet",
  },
  {
    id: "ETH-SEPOLIA",
    label: "Ethereum Sepolia",
  },
  {
    id: "SOLANA-DEVNET",
    label: "Solana Devnet",
  },
];

const APP_TREASURY_WALLET_TITLE = "Source Treasury Wallet";
const APP_TREASURY_WALLET_LABEL = "source treasury wallet";
const BRIDGE_ASSET_SYMBOL = "USDC";
const BRIDGE_EXTERNAL_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_WIZPAY_BRIDGE_EXTERNAL_ENABLED ?? "")
    .trim()
    .toLowerCase()
);

const USDC_ADDRESS_BY_CHAIN: Partial<Record<CircleTransferBlockchain, string>> = {
  "ARC-TESTNET": USDC_ADDRESS,
  "ETH-SEPOLIA": ETHEREUM_SEPOLIA_USDC_ADDRESS,
  // Solana Devnet USDC (Circle official SPL token)
  "SOLANA-DEVNET": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

function getOptionByChain(chain: CircleTransferBlockchain) {
  return (
    DESTINATION_OPTIONS.find((option) => option.id === chain) ??
    DESTINATION_OPTIONS[0]
  );
}

function getDefaultDestinationBlockchain(
  sourceBlockchain: CircleTransferBlockchain
): CircleTransferBlockchain {
  return (
    DESTINATION_OPTIONS.find((option) => option.id !== sourceBlockchain)?.id ??
    "ARC-TESTNET"
  );
}

/** Whether a chain uses Solana (non-EVM) address format. */
function isSolanaChain(chain: CircleTransferBlockchain): boolean {
  return chain === "SOLANA-DEVNET";
}

/** Validate destination address for the selected chain. */
function isValidDestinationAddress(
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

function normalizeBridgeStepId(value: string | undefined): BridgeStepId | null {
  if (value === "burn" || value === "attestation" || value === "mint") {
    return value;
  }

  return null;
}

function isTrackedTransfer(
  transfer: CircleTransfer | null
): transfer is CircleTransfer {
  return Boolean(
    transfer && (transfer.status === "pending" || transfer.status === "processing")
  );
}

function isPositiveDecimal(input: string) {
  if (!input.trim()) {
    return false;
  }

  return /^\d+(?:\.\d+)?$/.test(input) && Number(input) > 0;
}

function isValidAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function shortenAddress(address: string | null | undefined) {
  if (!address) {
    return "Unavailable";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function hasExplorerTxHash(url: string | null | undefined) {
  if (!url) {
    return false;
  }

  // Match EVM tx hash (0x + 64 hex chars) or Solana signature (base58, 64-88 chars)
  return /\/tx\/(0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{64,88})(?:$|[/?#])/.test(url);
}

function getStoredTransferWallet(blockchain: CircleTransferBlockchain) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(TRANSFER_WALLET_STORAGE_KEY);

    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue) as StoredTransferWalletMap;

    return parsedValue[blockchain] ?? null;
  } catch {
    return null;
  }
}

function setStoredTransferWallet(
  blockchain: CircleTransferBlockchain,
  wallet: CircleTransferWallet
) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const currentWallets = getStoredTransferWallets();
    currentWallets[blockchain] = {
      walletId: wallet.walletId,
      walletAddress: wallet.walletAddress,
      walletSetId: wallet.walletSetId,
    };
    window.localStorage.setItem(
      TRANSFER_WALLET_STORAGE_KEY,
      JSON.stringify(currentWallets)
    );
  } catch {
    return;
  }
}

function clearStoredTransferWallet(blockchain: CircleTransferBlockchain) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const currentWallets = getStoredTransferWallets();
    delete currentWallets[blockchain];
    window.localStorage.setItem(
      TRANSFER_WALLET_STORAGE_KEY,
      JSON.stringify(currentWallets)
    );
  } catch {
    return;
  }
}

function getStoredTransferWallets(): StoredTransferWalletMap {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(TRANSFER_WALLET_STORAGE_KEY);

    return rawValue ? (JSON.parse(rawValue) as StoredTransferWalletMap) : {};
  } catch {
    return {};
  }
}

function getStoredActiveTransfer() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(ACTIVE_TRANSFER_STORAGE_KEY);

    return rawValue ? (JSON.parse(rawValue) as CircleTransfer) : null;
  } catch {
    return null;
  }
}

function setStoredActiveTransfer(transfer: CircleTransfer) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      ACTIVE_TRANSFER_STORAGE_KEY,
      JSON.stringify(transfer)
    );
  } catch {
    return;
  }
}

function clearStoredActiveTransfer() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(ACTIVE_TRANSFER_STORAGE_KEY);
  } catch {
    return;
  }
}

function getErrorDetails(error: TransferApiError | null) {
  if (!error?.details || typeof error.details !== "object") {
    return null;
  }

  return error.details as Record<string, unknown>;
}

function getTreasuryFundingMessage({
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

function getTreasurySetupMessage(networkLabel: string) {
  return `Bridge requires an ${APP_TREASURY_WALLET_LABEL} on ${networkLabel}. Initialize it below, then fund it with ${BRIDGE_ASSET_SYMBOL} before bridging.`;
}

function getBridgeErrorMessage(
  error: unknown,
  labels: {
    destinationLabel: string;
    sourceLabel: string;
  }
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
      failedStep && typeof failedStep.name === "string" ? failedStep.name : null;
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
      typeof details?.availableAmount === "string" ? details.availableAmount : "0";
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
    message.includes("Custom\":1") &&
    message.toLowerCase().includes("network: devnet")
  ) {
    return "Solana source treasury wallet has insufficient SOL for network fees. Fund it with a small SOL amount on Devnet, then retry.";
  }

  if (message.includes("fetch failed")) {
    return "The bridge request could not reach the local app server. Reload the page and retry.";
  }

  return message;
}

function formatWalletBalance(
  wallet: CircleTransferWallet | null,
  tokenSymbol: string
) {
  if (!wallet?.balance) {
    return `0 ${tokenSymbol}`;
  }

  return `${wallet.balance.amount} ${wallet.balance.symbol || tokenSymbol}`;
}

function getOrderedBridgeSteps(
  transfer: CircleTransfer,
  sourceLabel: string,
  destinationLabel: string
): CircleTransferStep[] {
  return STEP_ORDER.map((stepId) => {
    const step = transfer.steps.find((candidate) => candidate.id === stepId);

    if (step) {
      return step;
    }

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

function getCurrentStepId(
  transfer: CircleTransfer | null,
  steps: CircleTransferStep[]
): BridgeStepId | null {
  if (!transfer || steps.length === 0) {
    return null;
  }

  const failedStep = steps.find((step) => step.state === "error");

  if (failedStep) {
    return normalizeBridgeStepId(failedStep.id);
  }

  if (transfer.status === "settled") {
    return "mint";
  }

  const pendingStep = steps.find((step) => step.state === "pending");

  if (pendingStep) {
    return normalizeBridgeStepId(pendingStep.id);
  }

  const inFlightStep = steps.find(
    (step) => step.state !== "success" && step.state !== "noop"
  );

  if (inFlightStep) {
    return normalizeBridgeStepId(inFlightStep.id);
  }

  return normalizeBridgeStepId(steps[steps.length - 1]?.id);
}

function getTransferHeadline(
  transfer: CircleTransfer,
  currentStepName: string | undefined
) {
  if (transfer.status === "settled") {
    return "Bridge completed successfully";
  }

  if (transfer.status === "failed") {
    return "Bridge needs attention";
  }

  if (transfer.rawStatus === "attested") {
    return "Attestation received, mint is next";
  }

  if (transfer.rawStatus === "burned") {
    return "Burn confirmed, waiting for attestation";
  }

  return currentStepName || "Bridge submitted";
}

function getTransferStatusLabel(transfer: CircleTransfer) {
  if (transfer.status === "settled") {
    return "Completed";
  }

  if (transfer.status === "failed") {
    return "Failed";
  }

  if (transfer.rawStatus === "attested") {
    return "Minting";
  }

  if (transfer.rawStatus === "burned") {
    return "Awaiting attestation";
  }

  return transfer.status === "processing" ? "Processing" : "Queued";
}

function getStatusBadgeClass(transfer: CircleTransfer) {
  if (transfer.status === "settled") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-300";
  }

  if (transfer.status === "failed") {
    return "border-destructive/25 bg-destructive/10 text-destructive";
  }

  if (transfer.rawStatus === "attested") {
    return "border-primary/25 bg-primary/10 text-primary";
  }

  return "border-amber-500/25 bg-amber-500/10 text-amber-300";
}

function getStepStatusLabel(
  step: CircleTransferStep,
  currentStepId: BridgeStepId | null,
  transferStatus: CircleTransfer["status"]
) {
  const stepId = normalizeBridgeStepId(step.id);

  if (step.state === "success") {
    return "Success";
  }

  if (step.state === "error") {
    return "Failed";
  }

  if (transferStatus === "settled" && stepId === "mint") {
    return "Success";
  }

  if (currentStepId && stepId === currentStepId) {
    return "In progress";
  }

  return "Pending";
}

function getLastUpdatedLabel(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function getLongRunningTransferMessage(
  transfer: CircleTransfer,
  currentStepId: BridgeStepId | null,
  labels: {
    destinationLabel: string;
    sourceLabel: string;
  }
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

function recoverTerminalTransfer(
  transfer: CircleTransfer | null
): CircleTransfer | null {
  if (!transfer) {
    return null;
  }

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

export function BridgeScreen() {
  const {
    arcWallet,
    sepoliaWallet,
    solanaWallet,
    authMethod,
    createContractExecutionChallenge,
    createTransferChallenge,
    executeChallenge,
    getWalletBalances,
    savePasskeySolanaAddress,
    userEmail,
  } = useCircleWallet();
  const { activeWalletLabel, walletMode, externalWalletAddress, externalWalletChainId } = useHybridWallet();
  const { data: externalWalletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const { toast } = useToast();
  const restoredTransferRef = useRef(false);
  const terminalNoticeRef = useRef<string | null>(null);
  const reconnectingPollCountRef = useRef(0);

  const [sourceChain, setSourceChain] = useState<CircleTransferBlockchain>(
    DEFAULT_SOURCE_BLOCKCHAIN
  );
  const [destinationChain, setDestinationChain] = useState<CircleTransferBlockchain>(
    getDefaultDestinationBlockchain(DEFAULT_SOURCE_BLOCKCHAIN)
  );
  const [amount, setAmount] = useState("");
  const [destinationAddress, setDestinationAddress] = useState("");
  const [transfer, setTransfer] = useState<CircleTransfer | null>(null);
  const [transferWallet, setTransferWallet] = useState<CircleTransferWallet | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [walletStatusError, setWalletStatusError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDepositingToTreasury, setIsDepositingToTreasury] = useState(false);
  const [isWalletLoading, setIsWalletLoading] = useState(false);
  const [isWalletBootstrapping, setIsWalletBootstrapping] = useState(false);
  const [isPollingTransfer, setIsPollingTransfer] = useState(false);
  const [isReconnectingToTracking, setIsReconnectingToTracking] = useState(false);
  const [isReviewDialogOpen, setIsReviewDialogOpen] = useState(false);
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  const [destinationWallets, setDestinationWallets] =
    useState<DestinationWalletMap>({});
  const [isDestinationWalletsLoading, setIsDestinationWalletsLoading] =
    useState(false);
  const [copiedWallet, setCopiedWallet] = useState<string | null>(null);
  const [passkeySolanaInput, setPasskeySolanaInput] = useState("");
  const tokenSymbol = BRIDGE_ASSET_SYMBOL;

  const sourceOption = useMemo(() => getOptionByChain(sourceChain), [sourceChain]);
  const destinationOption = useMemo(
    () => getOptionByChain(destinationChain),
    [destinationChain]
  );
  const treasuryWalletOption = useMemo(
    () =>
      transferWallet ? getOptionByChain(transferWallet.blockchain) : sourceOption,
    [transferWallet, sourceOption]
  );
  const transferDestinationOption = useMemo(
    () => (transfer ? getOptionByChain(transfer.blockchain) : destinationOption),
    [transfer, destinationOption]
  );
  const transferSourceOption = useMemo(
    () => (transfer ? getOptionByChain(transfer.sourceBlockchain) : sourceOption),
    [transfer, sourceOption]
  );
  const suggestedDestinationAddress =
    destinationChain === "ARC-TESTNET"
      ? arcWallet?.address ?? ""
      : destinationChain === "ETH-SEPOLIA"
      ? sepoliaWallet?.address ?? ""
      : solanaWallet?.address ?? "";
  const destinationTokenAddress = USDC_ADDRESS_BY_CHAIN[destinationChain];
  const sourceTokenAddress = USDC_ADDRESS_BY_CHAIN[sourceChain];
  const isSameChainRoute = sourceChain === destinationChain;
  const bridgeExecutionMode =
    walletMode === "external" ? "external_signer" : "app_treasury";
  const isPasskeyWalletSession = authMethod === "passkey";
  const sourceAccountType =
    bridgeExecutionMode === "external_signer"
      ? "external_wallet"
      : "app_treasury_wallet";
  const isExternalBridgeMode = bridgeExecutionMode === "external_signer";
  const isExternalEvmBridge =
    isExternalBridgeMode &&
    BRIDGE_EXTERNAL_ENABLED &&
    !isSolanaChain(sourceChain) &&
    !isSolanaChain(destinationChain);
  const sourceChainId = CHAIN_ID_BY_BRIDGE_CHAIN[sourceChain];
  const destChainId = CHAIN_ID_BY_BRIDGE_CHAIN[destinationChain];
  const sourcePublicClient = usePublicClient({ chainId: sourceChainId });
  const destPublicClient = usePublicClient({ chainId: destChainId });
  const externalBridgeModeMessage = !BRIDGE_EXTERNAL_ENABLED
    ? `External wallet bridge is currently disabled. Switch to App Wallet (Circle) to continue.`
    : isSolanaChain(sourceChain) || isSolanaChain(destinationChain)
      ? `External wallet bridge does not support Solana routes. Switch to App Wallet (Circle) or select an EVM-only route.`
      : null;
  // Read external wallet USDC balance on the source chain for pre-flight checks
  const externalUsdcAddress =
    isExternalEvmBridge ? (sourceTokenAddress as Address | undefined) : undefined;
  const { data: externalUsdcBalanceRaw } = useReadContract({
    abi: ERC20_ABI,
    address: externalUsdcAddress,
    functionName: "balanceOf",
    args: externalWalletAddress ? [externalWalletAddress] : undefined,
    chainId: sourceChainId,
    query: {
      enabled: Boolean(
        isExternalEvmBridge && externalWalletAddress && externalUsdcAddress && sourceChainId
      ),
      staleTime: 10_000,
      refetchInterval: 15_000,
    },
  });
  const externalUsdcBalance =
    typeof externalUsdcBalanceRaw === "bigint"
      ? Number(formatUnits(externalUsdcBalanceRaw, CCTP_USDC_DECIMALS))
      : null;
  const externalUsdcBalanceLabel =
    externalUsdcBalance !== null
      ? `${externalUsdcBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`
      : "Loading...";
  const hasEnoughExternalUsdc =
    externalUsdcBalance === null ||
    !isPositiveDecimal(amount) ||
    externalUsdcBalance >= Number(amount);

  const requestedAmount = Number(amount || "0");
  const walletBalanceAmount = Number(transferWallet?.balance?.amount || "0");
  const walletBalanceKnown = transferWallet?.balance != null;
  const treasuryWalletEmpty =
    walletBalanceKnown && Number.isFinite(walletBalanceAmount) && walletBalanceAmount <= 0;
  const hasSufficientWalletBalance =
    !walletBalanceKnown ||
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0 ||
    walletBalanceAmount >= requestedAmount;
  const isTransferActive = isTrackedTransfer(transfer);
  const isExternalBridgeTransfer =
    transfer?.transferId?.startsWith("ext-") ?? false;
  const estimatedTimeLabel = useMemo(() => {
    const effectiveSource = transfer?.sourceBlockchain ?? sourceChain;
    return getEstimatedBridgeTimeLabel(
      effectiveSource,
      isExternalBridgeTransfer || isExternalEvmBridge
    );
  }, [
    isExternalBridgeTransfer,
    isExternalEvmBridge,
    sourceChain,
    transfer?.sourceBlockchain,
  ]);
  // A non-terminal transfer (not settled) that the user can manually dismiss.
  const canDismissTransfer =
    Boolean(transfer) && !isSubmitting && transfer?.status !== "settled";
  const canRetryExternalAttestation =
    isExternalBridgeTransfer &&
    Boolean(transfer?.txHashBurn) &&
    !isSubmitting &&
    (transfer?.rawStatus === "burned" ||
      transfer?.rawStatus === "attesting" ||
      transfer?.status === "failed");
  const pollTransferFnRef = useRef<(() => Promise<void>) | null>(null);
  const canSubmitAppWallet =
    !isExternalBridgeMode && Boolean(transferWallet) && hasSufficientWalletBalance;
  const canSubmitExternalWallet =
    isExternalEvmBridge &&
    Boolean(externalWalletAddress) &&
    hasEnoughExternalUsdc;
  const canSubmit =
    Boolean(destinationTokenAddress) &&
    Boolean(sourceTokenAddress) &&
    isPositiveDecimal(amount) &&
    !isSameChainRoute &&
    isValidDestinationAddress(destinationAddress, destinationChain) &&
    (canSubmitAppWallet || canSubmitExternalWallet) &&
    !isTransferActive;


  const orderedSteps = useMemo(
    () =>
      transfer
        ? getOrderedBridgeSteps(
            transfer,
            transferSourceOption.label,
            transferDestinationOption.label
          )
        : [],
    [transfer, transferDestinationOption.label, transferSourceOption.label]
  );
  const currentStepId = useMemo(
    () => getCurrentStepId(transfer, orderedSteps),
    [orderedSteps, transfer]
  );
  const currentStep = orderedSteps.find(
    (step) => normalizeBridgeStepId(step.id) === currentStepId
  );
  const burnStep = orderedSteps.find((step) => step.id === "burn");
  const mintStep = orderedSteps.find((step) => step.id === "mint");
  const burnExplorerUrl = hasExplorerTxHash(burnStep?.explorerUrl)
    ? burnStep?.explorerUrl
    : null;
  const mintExplorerUrl = hasExplorerTxHash(mintStep?.explorerUrl)
    ? mintStep?.explorerUrl
    : null;
  const shareBridgeUrl = mintExplorerUrl ?? burnExplorerUrl;
  const bridgeShareText = transfer
    ? `Bridge completed on WizPay: ${transfer.amount} ${tokenSymbol} from ${transferSourceOption.label} to ${transferDestinationOption.label}.${shareBridgeUrl ? `\n\nTrack tx: ${shareBridgeUrl}` : ""}`
    : "Bridge completed on WizPay.";
  const bridgeXShareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(
    bridgeShareText
  )}`;
  const transferAgeMs = transfer
    ? Date.now() - new Date(transfer.createdAt).getTime()
    : 0;
  const isTransferStuck =
    isTransferActive &&
    !isExternalBridgeTransfer &&
    transferAgeMs > BRIDGE_STUCK_TIMEOUT_MS;
  const shouldShowLongRunningMessage = Boolean(
    transfer &&
      isTransferActive &&
      transferAgeMs > BRIDGE_LONG_RUNNING_MS
  );
  const longRunningTransferMessage = useMemo(
    () =>
      transfer
        ? getLongRunningTransferMessage(transfer, currentStepId, {
            destinationLabel: transferDestinationOption.label,
            sourceLabel: transferSourceOption.label,
          })
        : null,
    [
      currentStepId,
      transfer,
      transferDestinationOption.label,
      transferSourceOption.label,
    ]
  );

  useEffect(() => {
    if (restoredTransferRef.current) {
      return;
    }

    restoredTransferRef.current = true;

    const storedTransfer = getStoredActiveTransfer();

    if (!storedTransfer) {
      return;
    }

    const recoveredTransfer = recoverTerminalTransfer(storedTransfer);

    if (recoveredTransfer) {
      clearStoredActiveTransfer();
      return;
    }

    // Don't restore stale terminal transfers - clear them instead
    if (storedTransfer.status === "settled" || storedTransfer.status === "failed") {
      clearStoredActiveTransfer();
      return;
    }

    // Auto-dismiss transfers that are older than the stuck timeout on restore.
    // This covers the case where the user returns to the page after a long gap
    // and the transfer has been processing way beyond the expected time window.
    const storedAgeMs = Date.now() - new Date(storedTransfer.createdAt).getTime();
    if (storedAgeMs > BRIDGE_STUCK_TIMEOUT_MS) {
      clearStoredActiveTransfer();
      return;
    }

    // Don't restore transfers that have a tx hash or external-wallet prefix as their
    // transferId — these are not valid backend task UUIDs and cannot be polled.
    if (
      storedTransfer.transferId.startsWith("0x") ||
      storedTransfer.transferId.startsWith("ext-")
    ) {
      clearStoredActiveTransfer();
      return;
    }

    setTransfer(storedTransfer);
    setSourceChain(storedTransfer.sourceBlockchain);
    setDestinationChain(storedTransfer.blockchain);
    setAmount(storedTransfer.amount);
    setDestinationAddress(storedTransfer.destinationAddress || "");
  }, []);

  useEffect(() => {
    if (isTransferActive) {
      return;
    }

    if (suggestedDestinationAddress) {
      setDestinationAddress(suggestedDestinationAddress);
      return;
    }

    setDestinationAddress("");
  }, [isTransferActive, suggestedDestinationAddress]);

  useEffect(() => {
    let cancelled = false;

    async function loadTransferWallet() {
      setIsWalletLoading(true);
      setTransferWallet((currentWallet) =>
        currentWallet?.blockchain === sourceChain ? currentWallet : null
      );

      const storedWallet = getStoredTransferWallet(sourceChain);

      try {
        const wallet = await getCircleTransferWallet({
          blockchain: sourceChain,
          tokenAddress: sourceTokenAddress,
          walletId: storedWallet?.walletId || undefined,
          walletAddress: storedWallet?.walletAddress || undefined,
        });

        if (cancelled) {
          return;
        }

        setTransferWallet(wallet);
        setStoredTransferWallet(sourceChain, wallet);
        setWalletStatusError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (
          error instanceof TransferApiError &&
          (error.code === "CIRCLE_WALLET_NOT_FOUND" ||
            error.code === "CIRCLE_WALLET_CONFIG_MISSING" ||
            error.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
            error.code === "CIRCLE_WALLET_ID_MISMATCH")
        ) {
          clearStoredTransferWallet(sourceChain);
        }

        setTransferWallet(null);
        setWalletStatusError(
          getBridgeErrorMessage(error, {
            destinationLabel: destinationOption.label,
            sourceLabel: sourceOption.label,
          })
        );
      } finally {
        if (!cancelled) {
          setIsWalletLoading(false);
        }
      }
    }

    void loadTransferWallet();

    return () => {
      cancelled = true;
    };
  }, [destinationOption.label, sourceChain, sourceOption.label, sourceTokenAddress]);

  useEffect(() => {
    if (!transfer) {
      return;
    }

    setStoredActiveTransfer(transfer);
  }, [transfer]);

  useEffect(() => {
    if (!transfer?.transferId || !isTransferActive || isExternalBridgeTransfer) {
      setIsPollingTransfer(false);
      setIsReconnectingToTracking(false);
      return;
    }

    const activeTransferId = transfer.transferId;
    let cancelled = false;

    async function pollTransfer() {
      setIsPollingTransfer(true);

      try {
        const latestTransfer = await getCircleTransferStatus(activeTransferId);

        if (cancelled) {
          return;
        }

        console.debug("Polling tx:", activeTransferId, "status:", latestTransfer.status);

        setTransfer(latestTransfer);
        setStoredActiveTransfer(latestTransfer);
        reconnectingPollCountRef.current = 0;
        setIsReconnectingToTracking(false);
        setErrorMessage(null);

        handleTerminalTransferUpdate(latestTransfer);
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (
          error instanceof TransferApiError &&
          error.code === "CIRCLE_BRIDGE_NOT_FOUND"
        ) {
          const recoveredTransfer = recoverTerminalTransfer(transfer);

          if (recoveredTransfer) {
            setTransfer(recoveredTransfer);
            setIsReconnectingToTracking(false);
            setErrorMessage(null);
            handleTerminalTransferUpdate(recoveredTransfer);
            return;
          }

          reconnectingPollCountRef.current += 1;
          // Auto-dismiss after 15 consecutive CIRCLE_BRIDGE_NOT_FOUND responses
          // (~1 minute). The backend task is gone and the transfer will never
          // reach a terminal state via polling, so clear state automatically.
          if (reconnectingPollCountRef.current >= 15) {
            reconnectingPollCountRef.current = 0;
            clearStoredActiveTransfer();
            setTransfer(null);
            setIsReconnectingToTracking(false);
            setErrorMessage(
              "Bridge tracking timed out. The task no longer exists on backend."
            );
            return;
          }

          setIsReconnectingToTracking(true);
          setErrorMessage(
            "Bridge belum terdeteksi di backend. Sistem sedang mencoba reconnect status..."
          );
          return;
        }

        setIsReconnectingToTracking(false);
        setErrorMessage(
          getBridgeErrorMessage(error, {
            destinationLabel: transferDestinationOption.label,
            sourceLabel: transferSourceOption.label,
          })
        );
      } finally {
        if (!cancelled) {
          setIsPollingTransfer(false);
        }
      }
    }

    pollTransferFnRef.current = pollTransfer;
    void pollTransfer();

    return () => {
      cancelled = true;
      pollTransferFnRef.current = null;
    };
  }, [
    isTransferActive,
    toast,
    tokenSymbol,
    transfer,
    transfer?.transferId,
    transferDestinationOption.label,
    transferSourceOption.label,
  ]);

  useAdaptivePolling({
    onPoll: () => void pollTransferFnRef.current?.(),
    activeInterval: BRIDGE_POLL_INTERVAL_MS,
    idleInterval: 15_000,
    idleAfter: 60_000,
    enabled: Boolean(transfer?.transferId) && isTransferActive,
  });

  function handleTerminalTransferUpdate(latestTransfer: CircleTransfer) {
    if (latestTransfer.status === "settled") {
      const terminalKey = `${latestTransfer.transferId}:settled`;

      if (terminalNoticeRef.current !== terminalKey) {
        terminalNoticeRef.current = terminalKey;
        setIsSuccessDialogOpen(true);
        clearStoredActiveTransfer();
        toast({
          title: "Bridge completed",
          description: `${tokenSymbol} arrived on ${transferDestinationOption.label}.`,
        });
        void refreshTransferWallet();
      }

      return;
    }

    if (latestTransfer.status === "failed") {
      const terminalKey = `${latestTransfer.transferId}:failed`;

      if (terminalNoticeRef.current !== terminalKey) {
        terminalNoticeRef.current = terminalKey;
        clearStoredActiveTransfer();
        toast({
          title: "Bridge transfer failed",
          description:
            latestTransfer.errorReason ||
            `Circle could not finish the ${transferSourceOption.label} to ${transferDestinationOption.label} bridge.`,
          variant: "destructive",
        });
        void refreshTransferWallet();
      }
    }
  }

  function dismissTransfer() {
    clearStoredActiveTransfer();
    setTransfer(null);
    setErrorMessage(null);
    setIsReconnectingToTracking(false);
    setIsSubmitting(false);
    setIsDepositingToTreasury(false);
    reconnectingPollCountRef.current = 0;
  }

  async function refreshTransferWallet() {
    setIsWalletLoading(true);
    setTransferWallet((currentWallet) =>
      currentWallet?.blockchain === sourceChain ? currentWallet : null
    );

    const storedWallet = getStoredTransferWallet(sourceChain);

    try {
      const wallet = await getCircleTransferWallet({
        blockchain: sourceChain,
        tokenAddress: sourceTokenAddress,
        walletId: storedWallet?.walletId || undefined,
        walletAddress: storedWallet?.walletAddress || undefined,
      });

      setTransferWallet(wallet);
      setStoredTransferWallet(sourceChain, wallet);
      setWalletStatusError(null);
    } catch (error) {
      if (
        error instanceof TransferApiError &&
        (error.code === "CIRCLE_WALLET_NOT_FOUND" ||
          error.code === "CIRCLE_WALLET_CONFIG_MISSING" ||
          error.code === "CIRCLE_WALLET_CHAIN_MISMATCH" ||
          error.code === "CIRCLE_WALLET_ID_MISMATCH")
      ) {
        clearStoredTransferWallet(sourceChain);
      }

      setTransferWallet(null);
      setWalletStatusError(
        getBridgeErrorMessage(error, {
          destinationLabel: destinationOption.label,
          sourceLabel: sourceOption.label,
        })
      );
    } finally {
      setIsWalletLoading(false);
    }
  }

  const copyWalletAddress = useCallback(async (address: string, key: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedWallet(key);
      window.setTimeout(() => setCopiedWallet(null), 2000);
    } catch {
      // clipboard not available
    }
  }, []);

  const handleSavePasskeySolana = useCallback(() => {
    const trimmed = passkeySolanaInput.trim();
    if (!trimmed) return;
    savePasskeySolanaAddress(trimmed);
    setPasskeySolanaInput("");
  }, [passkeySolanaInput, savePasskeySolanaAddress]);

  async function refreshDestinationWallets() {
    setIsDestinationWalletsLoading(true);

    const chains = DESTINATION_OPTIONS.map((option) => option.id);

    try {
      const entries = await Promise.all(
        chains.map(async (chain) => {
          const tokenAddress = USDC_ADDRESS_BY_CHAIN[chain];

          if (!tokenAddress) {
            return [chain, null] as const;
          }

          const storedWallet = getStoredTransferWallet(chain);

          try {
            const wallet = await getCircleTransferWallet({
              blockchain: chain,
              tokenAddress,
              walletId: storedWallet?.walletId || undefined,
              walletAddress: storedWallet?.walletAddress || undefined,
            });

            setStoredTransferWallet(chain, wallet);
            return [chain, wallet] as const;
          } catch {
            return [chain, null] as const;
          }
        })
      );

      const nextWallets: DestinationWalletMap = {};
      for (const [chain, wallet] of entries) {
        nextWallets[chain] = wallet;
      }
      setDestinationWallets(nextWallets);
    } finally {
      setIsDestinationWalletsLoading(false);
    }
  }

  useEffect(() => {
    void refreshDestinationWallets();
  }, []);

  async function handleBootstrapWallet() {
    setIsWalletBootstrapping(true);
    setWalletStatusError(null);

    try {
      const wallet = await bootstrapCircleTransferWallet({
        blockchain: sourceChain,
        tokenAddress: sourceTokenAddress,
        refId: `WIZPAY-BRIDGE-SOURCE-${sourceChain}-${Date.now()}`,
        walletName: `WizPay ${sourceOption.label} App Treasury Wallet`,
      });

      setTransferWallet(wallet);
      setStoredTransferWallet(sourceChain, wallet);
      void refreshDestinationWallets();
      setWalletStatusError(null);
      toast({
        title: "App treasury wallet ready",
        description: `Fund ${shortenAddress(wallet.walletAddress)} on ${sourceOption.label} with ${tokenSymbol} before bridging.`,
      });
    } catch (error) {
      const message = getBridgeErrorMessage(error, {
        destinationLabel: destinationOption.label,
        sourceLabel: sourceOption.label,
      });
      setWalletStatusError(message);
      toast({
        title: "Source wallet setup failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsWalletBootstrapping(false);
    }
  }

  function openBridgeReview() {
    // External wallet mode — allow EVM routes, block Solana and disabled flag
    if (isExternalBridgeMode) {
      if (externalBridgeModeMessage) {
        setErrorMessage(externalBridgeModeMessage);
        return;
      }
      // isExternalEvmBridge is true — skip treasury checks
      if (isTransferActive) {
        setErrorMessage(
          "A bridge is already running. You can leave this page and come back later while tracking continues in the background."
        );
        return;
      }
      if (isSameChainRoute) {
        setErrorMessage("Source and destination network must be different.");
        return;
      }
      if (
        !isPositiveDecimal(amount) ||
        !isValidDestinationAddress(destinationAddress, destinationChain)
      ) {
        setErrorMessage(
          "Enter a valid amount and destination address before starting the bridge."
        );
        return;
      }
      setErrorMessage(null);
      setIsReviewDialogOpen(true);
      return;
    }

    if (isTransferActive) {
      setErrorMessage(
        "A bridge is already running. You can leave this page and come back later while tracking continues in the background."
      );
      return;
    }

    if (!transferWallet) {
      setErrorMessage(getTreasurySetupMessage(sourceOption.label));
      return;
    }

    if (transferWallet.blockchain !== sourceChain) {
      setErrorMessage(
        `The displayed ${APP_TREASURY_WALLET_LABEL} does not match ${sourceOption.label}. Refresh the treasury wallet and try again.`
      );
      return;
    }

    if (!hasSufficientWalletBalance) {
      setErrorMessage(
        getTreasuryFundingMessage({
          networkLabel: sourceOption.label,
          availableAmount: transferWallet.balance?.amount || "0",
          symbol: transferWallet.balance?.symbol || tokenSymbol,
          walletAddress: transferWallet.walletAddress,
          requestedAmount: amount,
        })
      );
      return;
    }

    if (isSameChainRoute) {
      setErrorMessage("Source and destination network must be different.");
      return;
    }

    if (!canSubmit) {
      setErrorMessage(
        "Enter a valid amount and destination wallet before starting the bridge."
      );
      return;
    }

    setErrorMessage(null);
    setIsReviewDialogOpen(true);
  }

  function getExternalBridgeErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
    const lower = raw.toLowerCase();
    // User rejected the transaction in their wallet
    if (
      lower.includes("user rejected") ||
      lower.includes("user denied") ||
      lower.includes("rejected the request") ||
      // EIP-1193 error code 4001
      (error instanceof Object && "code" in error && (error as { code: unknown }).code === 4001)
    ) {
      return "Transaction rejected — you cancelled the wallet confirmation. Try again when ready.";
    }
    // Insufficient native gas
    if (
      lower.includes("insufficient funds") ||
      lower.includes("insufficient gas") ||
      lower.includes("gas required exceeds allowance")
    ) {
      return "Insufficient gas: your wallet doesn't have enough ETH/native token to pay for this transaction. Top up the wallet and retry.";
    }
    // Wrong chain (switch failed or still on wrong chain)
    if (lower.includes("chain") && (lower.includes("switch") || lower.includes("mismatch"))) {
      return "Chain switch failed. Please manually switch your wallet to the correct network and try again.";
    }
    // Circle attestation timed out (message from pollCctpV2Attestation)
    if (lower.includes("attestation") && lower.includes("timed out")) {
      return raw; // already descriptive from pollCctpV2Attestation
    }
    return raw;
  }

  function asHexTxHash(value: string | null | undefined): Hex | null {
    if (!value) {
      return null;
    }

    const trimmed = value.trim();
    return /^0x[a-fA-F0-9]+$/.test(trimmed) ? (trimmed as Hex) : null;
  }

  async function retryExternalAttestationAndMint() {
    if (!transfer || !isExternalBridgeTransfer) {
      return;
    }

    const srcChain = transfer.sourceBlockchain;
    const dstChain = transfer.blockchain;
    const srcChainId = CHAIN_ID_BY_BRIDGE_CHAIN[srcChain];
    const dstChainId = CHAIN_ID_BY_BRIDGE_CHAIN[dstChain];
    const srcCctpDomain = CCTP_DOMAIN_BY_CHAIN[srcChain];
    const burnTxHash = asHexTxHash(transfer.txHashBurn ?? transfer.txHash);

    if (!srcChainId || !dstChainId || srcCctpDomain === undefined || !burnTxHash) {
      setErrorMessage(
        "Cannot resume bridge: missing source/destination chain or burn transaction hash."
      );
      return;
    }

    if (!externalWalletClient) {
      setErrorMessage("External wallet not connected.");
      return;
    }

    const walletAddress = externalWalletClient.account?.address;
    if (!walletAddress) {
      setErrorMessage("Could not determine external wallet address.");
      return;
    }

    const dstChainDef = CHAIN_BY_ID[dstChainId];
    if (!dstChainDef) {
      setErrorMessage("Destination chain configuration not found.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setTransfer((prev) =>
      prev
        ? {
            ...prev,
            status: "processing",
            rawStatus: "attesting",
            stage: "attesting",
            errorReason: null,
            updatedAt: new Date().toISOString(),
            steps: prev.steps.map((step) =>
              step.id === "attestation"
                ? { ...step, state: "pending", errorMessage: null }
                : step.id === "mint"
                  ? { ...step, state: "pending", errorMessage: null }
                  : step
            ),
          }
        : prev
    );

    try {
      toast({
        title: "Retrying attestation",
        description: "Polling Circle attestation again for the burn transaction…",
      });

      const attestationResult = await pollCctpV2Attestation(
        srcCctpDomain,
        burnTxHash,
        (attempt) => {
          if (attempt > 1 && attempt % 6 === 0) {
            const elapsed = Math.floor(
              (attempt * CCTP_ATTESTATION_POLL_INTERVAL_MS) / 1000 / 60
            );
            toast({
              title: "Still waiting for attestation",
              description: `Circle attestation pending (~${elapsed} min elapsed)…`,
            });
          }
        }
      );

      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              rawStatus: "attested",
              stage: "minting",
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "attestation" ? { ...s, state: "success", errorMessage: null } : s
              ),
            }
          : prev
      );

      toast({
        title: "Switching network",
        description: `Switching wallet to ${getOptionByChain(dstChain).label}…`,
      });
      await switchChainAsync({ chainId: dstChainId });

      toast({
        title: "Mint USDC",
        description: `Minting ${transfer.amount} USDC on ${getOptionByChain(dstChain).label}…`,
      });

      const mintTxHash = await externalWalletClient.writeContract({
        abi: CCTP_MESSAGE_TRANSMITTER_ABI,
        account: walletAddress,
        address: CCTP_V2_MESSAGE_TRANSMITTER,
        args: [attestationResult.message, attestationResult.attestation],
        chain: dstChainDef,
        functionName: "receiveMessage",
      });

      const mintExplorerUrl = getCctpExplorerUrl(dstChain, mintTxHash);
      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              txHashMint: mintTxHash,
              rawStatus: "minting",
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "mint"
                  ? { ...s, txHash: mintTxHash, explorerUrl: mintExplorerUrl }
                  : s
              ),
            }
          : prev
      );

      await destPublicClient!.waitForTransactionReceipt({ hash: mintTxHash });

      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              stage: "completed",
              status: "settled",
              rawStatus: "completed",
              txHash: mintTxHash,
              txHashMint: mintTxHash,
              errorReason: null,
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "mint"
                  ? {
                      ...s,
                      state: "success",
                      txHash: mintTxHash,
                      explorerUrl: mintExplorerUrl,
                      errorMessage: null,
                    }
                  : s
              ),
            }
          : prev
      );

      clearStoredActiveTransfer();
      setIsSuccessDialogOpen(true);
      toast({
        title: "Bridge completed",
        description: `${transfer.amount} ${tokenSymbol} arrived on ${getOptionByChain(dstChain).label}.`,
      });
    } catch (error) {
      const errMsg = getExternalBridgeErrorMessage(error);
      const isAttestationTimeout = errMsg.toLowerCase().includes("attestation") && errMsg.toLowerCase().includes("timed out");

      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              status: isAttestationTimeout ? "processing" : "failed",
              rawStatus: isAttestationTimeout ? "burned" : "failed",
              stage: isAttestationTimeout ? "attesting" : "failed",
              errorReason: isAttestationTimeout ? null : errMsg,
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "attestation" && isAttestationTimeout
                  ? { ...s, state: "pending", errorMessage: null }
                  : s.state === "pending"
                    ? { ...s, state: "error", errorMessage: errMsg }
                    : s
              ),
            }
          : prev
      );

      setErrorMessage(
        isAttestationTimeout
          ? "Attestation is still pending. Try 'Retry attestation & mint' again in a few minutes."
          : errMsg
      );
      toast({
        title: isAttestationTimeout ? "Attestation still pending" : "Bridge retry failed",
        description: isAttestationTimeout
          ? "Circle has not published the attestation yet."
          : errMsg,
        variant: isAttestationTimeout ? undefined : "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitExternalBridge() {
    const srcChainId = CHAIN_ID_BY_BRIDGE_CHAIN[sourceChain];
    const dstChainId = CHAIN_ID_BY_BRIDGE_CHAIN[destinationChain];

    if (!srcChainId || !dstChainId) {
      setErrorMessage(
        "External wallet bridge only supports EVM chains (Arc Testnet and Ethereum Sepolia)."
      );
      return;
    }

    if (!externalWalletClient) {
      setErrorMessage(
        "External wallet not connected. Connect MetaMask or another wallet to continue."
      );
      return;
    }

    const walletAddress = externalWalletClient.account?.address;
    if (!walletAddress) {
      setErrorMessage("Could not determine external wallet address.");
      return;
    }

    const srcCctpDomain = CCTP_DOMAIN_BY_CHAIN[sourceChain];
    const dstCctpDomain = CCTP_DOMAIN_BY_CHAIN[destinationChain];
    if (srcCctpDomain === undefined || dstCctpDomain === undefined) {
      setErrorMessage("CCTP domain not configured for the selected chain pair.");
      return;
    }

    const burnTokenAddress = sourceTokenAddress as Address | undefined;
    if (!burnTokenAddress) {
      setErrorMessage("USDC token address not available for the source chain.");
      return;
    }

    const srcChainDef = CHAIN_BY_ID[srcChainId];
    const dstChainDef = CHAIN_BY_ID[dstChainId];
    if (!srcChainDef || !dstChainDef) {
      setErrorMessage("Chain configuration not found.");
      return;
    }

    const transferId = `ext-${Date.now()}`;
    const now = new Date().toISOString();
    const referenceId = `BRIDGE-EXT-${sourceChain}-TO-${destinationChain}-${Date.now()}`;
    const amountBigInt = parseUnits(amount, CCTP_USDC_DECIMALS);
    const mintRecipient = evmAddressToBytes32(destinationAddress as Address);

    const initialTransfer: CircleTransfer = {
      id: transferId,
      transferId,
      stage: "burning",
      status: "processing",
      rawStatus: "burning",
      txHash: null,
      txHashBurn: null,
      txHashMint: null,
      sourceAddress: walletAddress,
      walletId: null,
      walletAddress,
      sourceBlockchain: sourceChain,
      sourceChain,
      destinationChain,
      blockchain: destinationChain,
      destinationAddress,
      amount,
      tokenAddress: burnTokenAddress,
      provider: "CCTP V2 (External Wallet)",
      referenceId,
      createdAt: now,
      updatedAt: now,
      errorReason: null,
      steps: [
        {
          id: "burn",
          name: `Burn on ${sourceOption.label}`,
          state: "pending",
          txHash: null,
          explorerUrl: null,
          errorMessage: null,
        },
        {
          id: "attestation",
          name: "Waiting for Circle attestation",
          state: "pending",
          txHash: null,
          explorerUrl: null,
          errorMessage: null,
        },
        {
          id: "mint",
          name: `Mint on ${destinationOption.label}`,
          state: "pending",
          txHash: null,
          explorerUrl: null,
          errorMessage: null,
        },
      ],
    };

    setIsSubmitting(true);
    setErrorMessage(null);
    setIsReviewDialogOpen(false);
    setTransfer(initialTransfer);

    let burnTxHash: Hex | null = null;
    let burnExplorerUrl: string | null = null;

    try {
      // ── Step 1: Switch to source chain ──
      toast({
        title: "Switching network",
        description: `Switching wallet to ${sourceOption.label}…`,
      });
      await switchChainAsync({ chainId: srcChainId });

      // ── Step 2: Approve USDC spend by CCTP TokenMessenger ──
      toast({
        title: "Approve USDC",
        description: `Approve ${amount} USDC for CCTP bridge…`,
      });
      const approveTxHash = await externalWalletClient.writeContract({
        abi: CCTP_ERC20_APPROVE_ABI,
        account: walletAddress,
        address: burnTokenAddress,
        args: [CCTP_V2_TOKEN_MESSENGER, amountBigInt],
        chain: srcChainDef,
        functionName: "approve",
      });
      await sourcePublicClient!.waitForTransactionReceipt({ hash: approveTxHash });

      // ── Step 3: depositForBurn ──
      toast({
        title: "Burn USDC",
        description: `Burning ${amount} USDC on ${sourceOption.label} via CCTP…`,
      });
      burnTxHash = await externalWalletClient.writeContract({
        abi: CCTP_TOKEN_MESSENGER_ABI,
        account: walletAddress,
        address: CCTP_V2_TOKEN_MESSENGER,
        args: [
          amountBigInt,
          dstCctpDomain,
          mintRecipient,
          burnTokenAddress,
          ZERO_BYTES32,
          0n,
          CCTP_MIN_FINALITY_FAST,
        ],
        chain: srcChainDef,
        functionName: "depositForBurn",
      });

      burnExplorerUrl = getCctpExplorerUrl(sourceChain, burnTxHash);
      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              txHashBurn: burnTxHash,
              txHash: burnTxHash,
              rawStatus: "burning",
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "burn"
                  ? { ...s, txHash: burnTxHash, explorerUrl: burnExplorerUrl }
                  : s
              ),
            }
          : prev
      );

      const burnReceipt = await sourcePublicClient!.waitForTransactionReceipt({
        hash: burnTxHash,
      });

      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              rawStatus: "burned",
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "burn"
                  ? {
                      ...s,
                      state: "success",
                      txHash: burnTxHash,
                      explorerUrl: burnExplorerUrl,
                    }
                  : s
              ),
            }
          : prev
      );

      // ── Step 4: Extract CCTP message bytes from receipt logs ──
      const messageBytes = extractMessageBytesFromLogs(
        burnReceipt.logs as readonly {
          address: string;
          topics: readonly string[];
          data: string;
        }[]
      );
      if (!messageBytes) {
        throw new Error(
          "Could not extract the CCTP message from the burn transaction receipt. " +
            "The burn succeeded on-chain but attestation cannot proceed automatically."
        );
      }

      // ── Step 5: Poll Circle attestation API ──
      toast({
        title: "Waiting for attestation",
        description:
          "Circle is attesting the burn. This may take a few minutes on testnet…",
      });
      const attestationResult = await pollCctpV2Attestation(
        srcCctpDomain,
        burnTxHash,
        (attempt) => {
          if (attempt > 1 && attempt % 6 === 0) {
            const elapsed = Math.floor(
              (attempt * CCTP_ATTESTATION_POLL_INTERVAL_MS) / 1000 / 60
            );
            toast({
              title: "Still waiting for attestation",
              description: `Circle attestation pending (~${elapsed} min elapsed)…`,
            });
          }
        }
      );

      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              rawStatus: "attested",
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "attestation" ? { ...s, state: "success" } : s
              ),
            }
          : prev
      );

      // ── Step 6: Switch to destination chain ──
      toast({
        title: "Switching network",
        description: `Switching wallet to ${destinationOption.label}…`,
      });
      await switchChainAsync({ chainId: dstChainId });

      // ── Step 7: receiveMessage (mint) ──
      toast({
        title: "Mint USDC",
        description: `Minting ${amount} USDC on ${destinationOption.label}…`,
      });
      const mintTxHash = await externalWalletClient.writeContract({
        abi: CCTP_MESSAGE_TRANSMITTER_ABI,
        account: walletAddress,
        address: CCTP_V2_MESSAGE_TRANSMITTER,
        args: [attestationResult.message, attestationResult.attestation],
        chain: dstChainDef,
        functionName: "receiveMessage",
      });

      const mintExplorerUrl = getCctpExplorerUrl(destinationChain, mintTxHash);
      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              txHashMint: mintTxHash,
              rawStatus: "minting",
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "mint"
                  ? { ...s, txHash: mintTxHash, explorerUrl: mintExplorerUrl }
                  : s
              ),
            }
          : prev
      );

      await destPublicClient!.waitForTransactionReceipt({ hash: mintTxHash });

      // ── Complete ──
      const finalTransfer: CircleTransfer = {
        ...initialTransfer,
        stage: "completed",
        status: "settled",
        rawStatus: "completed",
        txHash: mintTxHash,
        txHashBurn: burnTxHash,
        txHashMint: mintTxHash,
        updatedAt: new Date().toISOString(),
        errorReason: null,
        steps: [
          {
            id: "burn",
            name: `Burn on ${sourceOption.label}`,
            state: "success",
            txHash: burnTxHash,
            explorerUrl: burnExplorerUrl,
            errorMessage: null,
          },
          {
            id: "attestation",
            name: "Circle attestation confirmed",
            state: "success",
            txHash: null,
            explorerUrl: null,
            errorMessage: null,
          },
          {
            id: "mint",
            name: `Mint on ${destinationOption.label}`,
            state: "success",
            txHash: mintTxHash,
            explorerUrl: mintExplorerUrl,
            errorMessage: null,
          },
        ],
      };

      setTransfer(finalTransfer);
      clearStoredActiveTransfer();

      // Audit log: notify backend so the transfer is traceable in server logs.
      // bridge.agent handles external_signer gracefully (returns a stub result).
      try {
        await createCircleTransfer({
          sourceBlockchain: sourceChain,
          blockchain: destinationChain,
          amount,
          destinationAddress,
          tokenAddress: burnTokenAddress,
          walletId: "",
          bridgeExecutionMode: "external_signer",
          sourceAccountType: "external_wallet",
        });
      } catch {
        // Non-fatal — audit log is best-effort. The bridge is already settled.
      }

      setIsSuccessDialogOpen(true);
      toast({
        title: "Bridge completed",
        description: `${amount} ${tokenSymbol} arrived on ${destinationOption.label}.`,
      });
    } catch (error) {
      const errMsg = getExternalBridgeErrorMessage(error);
      const isAttestationTimeout =
        errMsg.toLowerCase().includes("attestation") &&
        errMsg.toLowerCase().includes("timed out") &&
        Boolean(burnTxHash);

      setTransfer((prev) =>
        prev
          ? {
              ...prev,
              status: isAttestationTimeout ? "processing" : "failed",
              rawStatus: isAttestationTimeout ? "burned" : "failed",
              stage: isAttestationTimeout ? "attesting" : "failed",
              errorReason: isAttestationTimeout ? null : errMsg,
              updatedAt: new Date().toISOString(),
              steps: prev.steps.map((s) =>
                s.id === "attestation" && isAttestationTimeout
                  ? { ...s, state: "pending", errorMessage: null }
                  : s.state === "pending"
                  ? { ...s, state: "error", errorMessage: errMsg }
                  : s
              ),
            }
          : prev
      );
      setErrorMessage(
        isAttestationTimeout
          ? "Attestation is still pending. Use 'Retry attestation & mint' to continue when Circle publishes it."
          : errMsg
      );
      toast({
        title: isAttestationTimeout
          ? "Attestation still pending"
          : "Bridge transfer failed",
        description: isAttestationTimeout
          ? "Burn is confirmed. Retry attestation and mint in a few minutes."
          : errMsg,
        variant: isAttestationTimeout ? undefined : "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitBridge() {
    if (isPasskeyWalletSession) {
      if (!transferWallet) {
        setErrorMessage(getTreasurySetupMessage(sourceOption.label));
        setIsReviewDialogOpen(false);
        return;
      }

      if (transferWallet.blockchain !== sourceChain) {
        setErrorMessage(
          `The displayed ${APP_TREASURY_WALLET_LABEL} does not match ${sourceOption.label}. Refresh the treasury wallet and try again.`
        );
        setIsReviewDialogOpen(false);
        return;
      }

      setIsSubmitting(true);
      setErrorMessage(null);
      setIsReviewDialogOpen(false);
      setIsSuccessDialogOpen(false);
      reconnectingPollCountRef.current = 0;
      setIsReconnectingToTracking(false);

      try {
        const referenceId = `BRIDGE-${sourceChain}-TO-${destinationChain}-${Date.now()}`;
        const isSepoliaPasskeySource = sourceChain === "ETH-SEPOLIA";

        if (!isSepoliaPasskeySource) {
          const userSourceWallet =
            sourceChain === "ARC-TESTNET" ? arcWallet : solanaWallet;

          if (!userSourceWallet?.id) {
            throw new Error(`Personal ${sourceOption.label} wallet not connected.`);
          }

          const balances = await getWalletBalances(userSourceWallet.id);
          const usdcBalance = balances.find(
            (b) =>
              b.symbol === "USDC" ||
              b.tokenAddress?.toLowerCase() === sourceTokenAddress?.toLowerCase()
          );

          if (!usdcBalance) {
            throw new Error(
              `Could not find USDC token in your personal ${sourceOption.label} wallet. Available tokens: ${balances.map((b) => `${b.symbol}=${b.tokenAddress}`).join(", ")}`
            );
          }

          if (Number(usdcBalance.amount) < Number(amount)) {
            throw new Error(
              `Insufficient personal balance. You only have ${usdcBalance.amount} USDC on ${sourceOption.label}.`
            );
          }

          if (!sourceTokenAddress) {
            throw new Error(`USDC address is not configured for ${sourceOption.label}.`);
          }

          toast({
            title: "Step 1: Deposit",
            description: `Approve the transfer of ${amount} USDC from your ${sourceOption.label} wallet to the treasury wallet using passkey.`,
          });

          setIsDepositingToTreasury(true);

          const passkeyTransferCallData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [
              transferWallet.walletAddress as Address,
              parseUnits(amount.toString(), CCTP_USDC_DECIMALS),
            ],
          });

          const challenge = await createContractExecutionChallenge({
            walletId: userSourceWallet.id,
            contractAddress: sourceTokenAddress,
            callData: passkeyTransferCallData,
            refId: `PASSKEY-DEPOSIT-${referenceId}`,
          });

          await executeChallenge(challenge.challengeId);

          toast({
            title: "Step 2: Bridge",
            description: "Deposit confirmed. Executing bridge from the funded treasury wallet...",
          });

          await new Promise((resolve) => setTimeout(resolve, 2500));
          setIsDepositingToTreasury(false);
        } else {
          // Sepolia passkey source: treasury-direct bridge (no personal wallet deposit).
          toast({
            title: "Bridge",
            description: `Ethereum Sepolia passkey wallets use treasury-direct bridging. Initiating bridge of ${amount} USDC to ${destinationOption.label}...`,
          });
        }

        const queuedTransfer = await createCircleTransfer({
          amount,
          blockchain: destinationChain,
          sourceBlockchain: sourceChain,
          bridgeExecutionMode: "app_treasury",
          sourceAccountType: "app_treasury_wallet",
          destinationAddress,
          referenceId,
          tokenAddress: destinationTokenAddress,
          walletId: transferWallet.walletId || undefined,
          walletAddress: transferWallet.walletAddress,
          userEmail: userEmail || undefined,
          // IMPORTANT:
          // For treasury bridge execution we must use the existing bridge agent
          // path (real backend on-chain execution). PASSKEY mode in backend
          // currently records external_signer intent only.
          walletMode: "W3S",
        });

        terminalNoticeRef.current = null;
        setTransfer(queuedTransfer);
        setStoredActiveTransfer(queuedTransfer);
        setSourceChain(queuedTransfer.sourceBlockchain);
        setDestinationChain(queuedTransfer.blockchain);
        setAmount(queuedTransfer.amount);
        setDestinationAddress(queuedTransfer.destinationAddress || destinationAddress);
        toast({
          title: "Bridge started",
          description: `Passkey bridge started. Estimated time ${estimatedTimeLabel}.`,
        });
      } catch (error) {
        const message = getBridgeErrorMessage(error, {
          destinationLabel: destinationOption.label,
          sourceLabel: sourceOption.label,
        });
        setErrorMessage(message);
        toast({
          title: "Bridge transfer failed",
          description: message,
          variant: "destructive",
        });
      } finally {
        setIsSubmitting(false);
        setIsDepositingToTreasury(false);
      }

      return;
    }

    if (isExternalEvmBridge) {
      await submitExternalBridge();
      return;
    }

    if (isExternalBridgeMode) {
      setErrorMessage(
        externalBridgeModeMessage ??
          "External wallet bridge is not available for the selected route."
      );
      setIsReviewDialogOpen(false);
      return;
    }

    if (!transferWallet) {
      setErrorMessage(getTreasurySetupMessage(sourceOption.label));
      setIsReviewDialogOpen(false);
      return;
    }

    if (transferWallet.blockchain !== sourceChain) {
      setErrorMessage(
        `The displayed ${APP_TREASURY_WALLET_LABEL} does not match ${sourceOption.label}. Refresh the treasury wallet and try again.`
      );
      setIsReviewDialogOpen(false);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setIsReviewDialogOpen(false);
    setIsSuccessDialogOpen(false);
    reconnectingPollCountRef.current = 0;
    setIsReconnectingToTracking(false);

    try {
      const referenceId = `BRIDGE-${sourceChain}-TO-${destinationChain}-${Date.now()}`;

      const userSourceWallet =
        sourceChain === "ARC-TESTNET"
          ? arcWallet
          : sourceChain === "ETH-SEPOLIA"
            ? sepoliaWallet
            : solanaWallet;

      if (!userSourceWallet?.id) {
        throw new Error(`Personal ${sourceOption.label} wallet not connected.`);
      }

      const balances = await getWalletBalances(userSourceWallet.id);
      const usdcBalance = balances.find(
        (b) =>
          b.symbol === "USDC" ||
          b.tokenAddress?.toLowerCase() === sourceTokenAddress?.toLowerCase()
      );

      if (!usdcBalance) {
        throw new Error(
          `Could not find USDC token in your personal ${sourceOption.label} wallet. Available tokens: ${balances.map((b) => `${b.symbol}=${b.tokenAddress}`).join(", ")}`
        );
      }

      if (!usdcBalance.tokenId) {
        throw new Error(
          `USDC tokenId for ${sourceOption.label} is missing. Refresh wallet balances and retry.`
        );
      }

      if (Number(usdcBalance.amount) < Number(amount)) {
        throw new Error(
          `Insufficient personal balance. You only have ${usdcBalance.amount} USDC on ${sourceOption.label}.`
        );
      }

      toast({
        title: "Step 1: Deposit",
        description: `Approve the transfer of ${amount} USDC from your ${sourceOption.label} wallet to the treasury wallet via Circle popup.`,
      });

      setIsDepositingToTreasury(true);

      const transferChallenge = await createTransferChallenge({
        walletId: userSourceWallet.id,
        destinationAddress: transferWallet.walletAddress,
        tokenId: usdcBalance.tokenId,
        amounts: [amount.toString()],
        refId: `W3S-DEPOSIT-${referenceId}`,
      });

      await executeChallenge(transferChallenge.challengeId);

      toast({
        title: "Step 2: Bridge",
        description:
          "Deposit confirmed. Executing bridge from the funded treasury wallet...",
      });

      await new Promise((resolve) => setTimeout(resolve, 2500));
      setIsDepositingToTreasury(false);

      const queuedTransfer = await createCircleTransfer({
        amount,
        blockchain: destinationChain,
        sourceBlockchain: sourceChain,
        bridgeExecutionMode,
        sourceAccountType,
        destinationAddress,
        referenceId,
        tokenAddress: destinationTokenAddress,
        walletId: transferWallet.walletId || undefined,
        walletAddress: transferWallet.walletAddress,
        userEmail: userEmail || undefined,
        walletMode: "W3S",
      });

      terminalNoticeRef.current = null;
      setTransfer(queuedTransfer);
      setStoredActiveTransfer(queuedTransfer);
      setSourceChain(queuedTransfer.sourceBlockchain);
      setDestinationChain(queuedTransfer.blockchain);
      setAmount(queuedTransfer.amount);
      setDestinationAddress(queuedTransfer.destinationAddress || destinationAddress);
      toast({
        title: "Bridge started",
        description: `Estimated time ${estimatedTimeLabel}. You can leave this page and come back later while Circle finishes the bridge.`,
      });
    } catch (error) {
      const message = getBridgeErrorMessage(error, {
        destinationLabel: destinationOption.label,
        sourceLabel: sourceOption.label,
      });
      setErrorMessage(message);
      toast({
        title: "Bridge transfer failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
      setIsDepositingToTreasury(false);
    }
  }

  return (
    <div className="animate-fade-up space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Bridge
          </h1>
          <p className="text-sm text-muted-foreground/70">
            Circle CCTP flow that first asks your personal Circle wallet to
            fund the source treasury, then forwards testnet USDC across Arc,
            Sepolia, and Solana Devnet.
          </p>
        </div>
      </div>

      <Card className="glass-card overflow-hidden border-border/40">
        <CardHeader className="relative overflow-hidden border-b border-border/30 pb-5">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
          <CardTitle className="flex items-center gap-2 text-xl">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Route className="h-4.5 w-4.5" />
            </div>
            User-Confirmed Bridge
          </CardTitle>
          <CardDescription>
            Choose source and destination networks. WizPay will request a
            Circle wallet approval to move funds from your personal source
            wallet into the source treasury, then Circle burns on the selected
            source chain and mints on the selected destination chain.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 py-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="space-y-5">
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary/80">
                Treasury model
              </p>
              <p className="mt-2 text-sm text-muted-foreground/80">
                This bridge still uses an app-owned Circle developer-controlled
                treasury wallet on the selected source network, but it now
                starts with a Circle popup so you can approve a USDC deposit
                from your personal source wallet into that treasury wallet.
              </p>
            </div>

            {isExternalBridgeMode && externalBridgeModeMessage ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                {externalBridgeModeMessage}
              </div>
            ) : isExternalEvmBridge ? (
              <div className="space-y-3">
                <div className="rounded-2xl border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary/90">
                  External wallet mode: your connected wallet will sign each CCTP V2
                  step directly (approve → burn → mint). No treasury wallet required.
                </div>
                {externalWalletAddress ? (
                  <div className="rounded-2xl border border-border/40 bg-background/40 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">Connected wallet</span>
                      <span className="font-mono text-xs">{shortenAddress(externalWalletAddress)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-muted-foreground/70">USDC balance ({sourceOption.label})</span>
                      <span className={`font-mono text-xs ${
                        !hasEnoughExternalUsdc ? "text-destructive" : ""
                      }`}>{externalUsdcBalanceLabel}</span>
                    </div>
                    {externalWalletChainId && externalWalletChainId !== sourceChainId ? (
                      <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                        Wallet is on a different chain. It will auto-switch when you start the bridge.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {isPositiveDecimal(amount) && !hasEnoughExternalUsdc ? (
                  <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    Insufficient USDC: wallet holds {externalUsdcBalanceLabel} on {sourceOption.label},
                    but {amount} USDC is needed. Fund the wallet before bridging.
                  </div>
                ) : null}
              </div>
            ) : null}

            {transfer ? (
              <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary/80">
                      Bridge progress
                    </p>
                    <h2 className="mt-2 text-lg font-semibold text-foreground">
                      {getTransferHeadline(transfer, currentStep?.name)}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground/80">
                      Estimated time {estimatedTimeLabel}. You can leave
                      this page and tracking will resume when you return.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <div
                      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${getStatusBadgeClass(
                        transfer
                      )}`}
                    >
                      {isPollingTransfer && isTransferActive ? (
                        <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : transfer.status === "settled" ? (
                        <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                      ) : transfer.status === "failed" ? (
                        <AlertTriangle className="mr-2 h-3.5 w-3.5" />
                      ) : (
                        <Clock3 className="mr-2 h-3.5 w-3.5" />
                      )}
                      {getTransferStatusLabel(transfer)}
                    </div>
                    {canDismissTransfer ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-3 text-xs"
                        onClick={dismissTransfer}
                        disabled={isSubmitting}
                      >
                        Start new bridge
                      </Button>
                    ) : null}
                  </div>
                </div>

                {shouldShowLongRunningMessage ? (
                  <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                    {longRunningTransferMessage}
                  </div>
                ) : null}

                {isTransferStuck ? (
                  <div className="mt-4 rounded-2xl border border-destructive/25 bg-destructive/5 p-4">
                    <p className="text-sm font-semibold text-destructive">
                      Transfer has been processing for over 15 minutes
                    </p>
                    <p className="mt-1 text-sm text-destructive/80">
                      The Circle bridge did not complete within the expected time.
                      This is likely a testnet congestion or attestation failure.
                      You can safely dismiss this and start a new bridge.
                    </p>
                    {canRetryExternalAttestation ? (
                      <Button
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                          void retryExternalAttestationAndMint();
                        }}
                        disabled={isSubmitting}
                      >
                        Retry attestation & mint
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="destructive"
                      className="mt-3"
                      onClick={dismissTransfer}
                    >
                      Dismiss and start new bridge
                    </Button>
                  </div>
                ) : isReconnectingToTracking ? (
                  <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                    Reconnecting to tracking... Redis cache was cleared or
                    rotated, so WizPay is retrying from durable bridge history
                    until this transfer reaches a final state.
                  </div>
                ) : null}

                <div className="mt-4 space-y-3">
                  {orderedSteps.map((step) => {
                    const stepId = normalizeBridgeStepId(step.id);
                    const isCurrentStep =
                      Boolean(stepId && currentStepId && stepId === currentStepId) &&
                      isTransferActive;
                    const statusLabel = getStepStatusLabel(
                      step,
                      currentStepId,
                      transfer.status
                    );

                    return (
                      <div
                        key={`${transfer.transferId}-${step.id}`}
                        className={`rounded-2xl border p-4 ${
                          step.state === "success"
                            ? "border-emerald-500/25 bg-emerald-500/5"
                            : step.state === "error"
                              ? "border-destructive/25 bg-destructive/5"
                              : isCurrentStep
                                ? "border-primary/25 bg-primary/5"
                                : "border-border/30 bg-background/40"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-start gap-3">
                            <div
                              className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl ${
                                step.state === "success"
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : step.state === "error"
                                    ? "bg-destructive/10 text-destructive"
                                    : isCurrentStep
                                      ? "bg-primary/15 text-primary"
                                      : "bg-background/60 text-muted-foreground/70"
                              }`}
                            >
                              {step.state === "success" ? (
                                <CheckCircle2 className="h-4.5 w-4.5" />
                              ) : step.state === "error" ? (
                                <AlertTriangle className="h-4.5 w-4.5" />
                              ) : isCurrentStep ? (
                                <RefreshCw className="h-4.5 w-4.5 animate-spin" />
                              ) : (
                                <Clock3 className="h-4.5 w-4.5" />
                              )}
                            </div>
                            <div>
                              <p className="font-medium text-foreground">{step.name}</p>
                              <p className="mt-1 text-xs text-muted-foreground/70">
                                {statusLabel}
                              </p>
                              {step.txHash ? (
                                <p className="mt-2 font-mono text-xs text-muted-foreground/80">
                                  {shortenAddress(step.txHash)}
                                </p>
                              ) : null}
                              {step.errorMessage ? (
                                <p className="mt-2 text-xs text-destructive">
                                  {step.errorMessage}
                                </p>
                              ) : null}
                            </div>
                          </div>
                          {step.explorerUrl ? (
                            <Button asChild size="sm" variant="outline">
                              <a
                                href={step.explorerUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <ExternalLink className="h-4 w-4" />
                                View tx
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-border/30 bg-background/40 p-4 text-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                      Transfer ID
                    </p>
                    <p className="mt-2 font-mono text-xs text-muted-foreground/80">
                      {transfer.transferId}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-border/30 bg-background/40 p-4 text-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                      Route
                    </p>
                    <p className="mt-2 font-medium text-foreground">
                      {transferSourceOption.label} to {transferDestinationOption.label}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground/70">
                      Last updated {getLastUpdatedLabel(transfer.updatedAt)}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Source network
                </label>
                <Select
                  value={sourceChain}
                  onValueChange={(value) => {
                    const newSource = value as CircleTransferBlockchain;
                    if (newSource === destinationChain) {
                      const fallbackDestination =
                        getDefaultDestinationBlockchain(newSource);
                      setDestinationChain(fallbackDestination);
                      if (
                        isSolanaChain(fallbackDestination) !==
                        isSolanaChain(destinationChain)
                      ) {
                        setDestinationAddress("");
                      }
                    }
                    setSourceChain(newSource);
                  }}
                  disabled={isTransferActive || isSubmitting}
                >
                  <SelectTrigger className="h-11 border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DESTINATION_OPTIONS.filter(
                      (option) => option.id !== destinationChain
                    ).map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Destination network
                </label>
                <Select
                  value={destinationChain}
                  onValueChange={(value) => {
                    const newDestination = value as CircleTransferBlockchain;
                    if (newDestination === sourceChain) {
                      return;
                    }
                    // Clear address when chain type changes (EVM <-> Solana)
                    if (isSolanaChain(newDestination) !== isSolanaChain(destinationChain)) {
                      setDestinationAddress("");
                    }
                    setDestinationChain(newDestination);
                  }}
                  disabled={isTransferActive || isSubmitting}
                >
                  <SelectTrigger className="h-11 border-border/40 bg-background/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DESTINATION_OPTIONS.filter(
                      (option) => option.id !== sourceChain
                    ).map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="rounded-2xl border border-border/30 bg-background/35 px-4 py-3 text-sm text-muted-foreground/80">
              Route: approve a deposit from your personal {sourceOption.label}{" "}
              wallet into the source treasury wallet, then burn from treasury
              and mint to your destination address on {destinationOption.label}.
            </div>

            {isSameChainRoute ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Source and destination network must be different.
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Amount
                </label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.000001"
                  placeholder="0.0"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="h-11 border-border/40 bg-background/50"
                  disabled={isTransferActive || isSubmitting}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                  Destination wallet
                </label>
                <Input
                  placeholder={isSolanaChain(destinationChain) ? "Solana base58 address..." : "0x..."}
                  value={destinationAddress}
                  onChange={(event) => setDestinationAddress(event.target.value)}
                  className="h-11 border-border/40 bg-background/50 font-mono text-xs"
                  disabled={isTransferActive || isSubmitting}
                />
              </div>
            </div>

            {errorMessage ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}

            {transferWallet && treasuryWalletEmpty && !isPositiveDecimal(amount) ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                Bridge requires USDC in the selected {sourceOption.label} source
                treasury wallet. If your funded wallet is on the other network,
                switch the source network above before bridging.
              </div>
            ) : null}

            {transferWallet && !hasSufficientWalletBalance && isPositiveDecimal(amount) ? (
              <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                {getTreasuryFundingMessage({
                  networkLabel: sourceOption.label,
                  availableAmount: transferWallet.balance?.amount || "0",
                  symbol: transferWallet.balance?.symbol || tokenSymbol,
                  walletAddress: transferWallet.walletAddress,
                  requestedAmount: amount,
                })}
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="rounded-2xl border border-border/30 bg-background/40 px-4 py-3 text-sm text-muted-foreground/80">
                A Circle wallet popup appears before the bridge starts so you
                can approve the deposit from your personal source wallet into
                the selected source treasury wallet. After that confirmation,
                the backend treasury wallet executes the bridge.
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button
                  onClick={openBridgeReview}
                  disabled={
                    isSubmitting ||
                    isWalletLoading ||
                    isWalletBootstrapping ||
                    (isExternalBridgeMode && !isExternalEvmBridge)
                  }
                  className="h-11 px-5"
                >
                  {isSubmitting ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Route className="h-4 w-4" />
                  )}
                  {isSubmitting ? "Starting bridge..." : `Bridge ${tokenSymbol}`}
                </Button>
                {isTransferActive ? (
                  <p className="text-sm text-muted-foreground/70">
                    A bridge is already running. You can leave this page and come
                    back later while tracking continues.
                  </p>
                ) : isExternalBridgeMode && !isExternalEvmBridge ? (
                  <p className="text-sm text-muted-foreground/70">
                    External wallet mode is selected. Solana Devnet routes only
                    work with App Wallet (Circle). Switch wallet mode or use an
                    EVM route (Arc Testnet ↔ Ethereum Sepolia).
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                    {APP_TREASURY_WALLET_TITLE}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    App-owned Circle developer-controlled wallet on the selected
                    source network. This is not your personal wallet.
                  </p>
                </div>
                {isWalletLoading || isWalletBootstrapping ? (
                  <RefreshCw className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground/60" />
                ) : null}
              </div>

              {transferWallet ? (
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Network</span>
                    <span className="font-medium">{treasuryWalletOption.label}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Asset</span>
                    <span className="font-medium">USDC only</span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-muted-foreground/70">Address</span>
                    <span className="max-w-[11rem] break-all text-right font-mono text-xs">
                      {transferWallet.walletAddress}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Balance</span>
                    <span className="font-medium">
                      {formatWalletBalance(transferWallet, tokenSymbol)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Circle Wallet ID</span>
                    <span className="font-mono text-xs">
                      {shortenAddress(transferWallet.walletId)}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground/70">
                  {walletStatusError ||
                    `No ${APP_TREASURY_WALLET_LABEL} is ready for ${sourceOption.label} yet. Initialize it below and fund it with ${tokenSymbol}.`}
                </p>
              )}

              <div className="mt-4 flex flex-col gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void refreshTransferWallet()}
                  disabled={isWalletLoading || isWalletBootstrapping}
                  className="w-full"
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh treasury wallet
                </Button>
                {!transferWallet ? (
                  <Button
                    size="sm"
                    onClick={handleBootstrapWallet}
                    disabled={isWalletLoading || isWalletBootstrapping}
                    className="w-full"
                  >
                    {isWalletBootstrapping ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Wallet className="h-4 w-4" />
                    )}
                    Initialize treasury wallet
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="outline" className="w-full">
                  <a
                    href="https://faucet.circle.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Droplet className="h-4 w-4" />
                    Open Circle faucet
                  </a>
                </Button>
                <p className="text-xs text-muted-foreground/70">
                  Fund this wallet with testnet USDC before starting the bridge.
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                Your destination wallets
              </p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                These are your personal Circle wallets across Arc, Sepolia, and
                Solana Devnet.
              </p>
              <div className="mt-3 space-y-3 text-sm">
                {(
                  [
                    {
                      key: "arc",
                      label: "Arc Testnet",
                      address: arcWallet?.address || destinationWallets["ARC-TESTNET"]?.walletAddress,
                    },
                    {
                      key: "sepolia",
                      label: "Ethereum Sepolia",
                      address: sepoliaWallet?.address || destinationWallets["ETH-SEPOLIA"]?.walletAddress,
                    },
                  ] as const
                ).map(({ key, label, address }) => (
                  <div key={key} className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                      <Wallet className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{label}</p>
                      <p className="font-mono text-xs text-muted-foreground/70 truncate">{shortenAddress(address)}</p>
                    </div>
                    {address ? (
                      <button
                        onClick={() => void copyWalletAddress(address, key)}
                        className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-primary/10"
                        title={`Copy ${label} address`}
                      >
                        {copiedWallet === key ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                    ) : null}
                  </div>
                ))}

                {/* Solana Devnet row */}
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
                    <Wallet className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Solana Devnet</p>
                    {solanaWallet?.address ? (
                      <div className="flex items-center gap-1">
                        <p className="font-mono text-xs text-muted-foreground/70 truncate">
                          {shortenAddress(solanaWallet.address)}
                        </p>
                        <button
                          onClick={() => void copyWalletAddress(solanaWallet.address, "solana")}
                          className="shrink-0 rounded-lg p-1 transition-colors hover:bg-primary/10"
                          title="Copy Solana address"
                        >
                          {copiedWallet === "solana" ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                      </div>
                    ) : isPasskeyWalletSession ? (
                      <div className="mt-1 space-y-1.5">
                        <p className="text-[11px] text-muted-foreground/70">
                          Passkey tidak mendukung Solana. Masukkan alamat Solana Anda untuk menyimpannya.
                        </p>
                        <div className="flex gap-1.5">
                          <Input
                            value={passkeySolanaInput}
                            onChange={(e) => setPasskeySolanaInput(e.target.value)}
                            placeholder="Alamat Solana…"
                            className="h-7 text-xs font-mono"
                            onKeyDown={(e) => { if (e.key === "Enter") handleSavePasskeySolana(); }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleSavePasskeySolana}
                            disabled={!passkeySolanaInput.trim()}
                            className="h-7 px-2 text-xs"
                          >
                            Simpan
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="font-mono text-xs text-muted-foreground/70">—</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void refreshDestinationWallets()}
                  disabled={isDestinationWalletsLoading}
                  className="w-full"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isDestinationWalletsLoading ? "animate-spin" : ""}`}
                  />
                  Refresh destination wallets
                </Button>
              </div>
            </div>

            <div className="rounded-2xl border border-border/40 bg-background/35 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                Transfer status
              </p>
              {transfer ? (
                <div className="mt-3 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Status</span>
                    <span className="font-medium">
                      {getTransferStatusLabel(transfer)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Route</span>
                    <span className="font-medium">
                      {transferSourceOption.label} to {transferDestinationOption.label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Transfer ID</span>
                    <span className="font-mono text-xs">
                      {shortenAddress(transfer.transferId)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Destination</span>
                    <span className="font-mono text-xs">
                      {shortenAddress(transfer.destinationAddress)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Provider</span>
                    <span className="font-medium">
                      {transfer.provider || "Circle Bridge Kit"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground/70">Last updated</span>
                    <span className="font-medium">
                      {getLastUpdatedLabel(transfer.updatedAt)}
                    </span>
                  </div>

                  {burnExplorerUrl || mintExplorerUrl ? (
                    <div className="grid gap-2">
                      {burnExplorerUrl ? (
                        <Button asChild size="sm" variant="outline" className="w-full">
                          <a
                            href={burnExplorerUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink className="h-4 w-4" />
                            View burn tx
                          </a>
                        </Button>
                      ) : null}
                      {mintExplorerUrl ? (
                        <Button asChild size="sm" variant="outline" className="w-full">
                          <a
                            href={mintExplorerUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink className="h-4 w-4" />
                            View mint tx
                          </a>
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground/70">
                  No bridge submitted yet.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Route className="h-4 w-4 text-primary" />
              CCTP flow
            </CardTitle>
            <CardDescription>
              The bridge runs through three Circle-controlled stages after your
              personal wallet deposit is approved.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground/80">
            <p>1. Approve a deposit from your personal source wallet to the treasury wallet.</p>
            <p>2. Burn USDC on the source chain treasury wallet and wait for Circle attestation.</p>
            <p>3. Mint USDC on the destination chain for the wallet you entered.</p>
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-primary" />
              Tracking
            </CardTitle>
            <CardDescription>
              This bridge is non-blocking by design.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground/80">
            <p>Status refreshes every 4 seconds while a bridge is pending.</p>
            <p>The latest transfer is stored locally so the page can resume after refresh.</p>
            <p>If the flow runs longer than 2 minutes, the UI tells the user it is still processing on-chain.</p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={isReviewDialogOpen} onOpenChange={setIsReviewDialogOpen}>
        <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/20">
              <Route className="h-7 w-7" />
            </div>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl">Review bridge transfer</DialogTitle>
              <DialogDescription>
                {isExternalEvmBridge
                  ? "Your external wallet will sign 3 transactions: USDC approve, burn (depositForBurn), and mint (receiveMessage) on the destination chain. Keep your wallet extension open."
                  : "This bridge will first open Circle Wallet so you can approve a deposit from your personal " + sourceOption.label + " wallet into the selected source treasury wallet. After that deposit is confirmed, the backend treasury wallet completes the bridge."}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground/70">Route</span>
                  <span className="font-medium">
                    {sourceOption.label} to {destinationOption.label}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground/70">Amount</span>
                  <span className="font-mono font-medium">
                    {amount || "0"} {tokenSymbol}
                  </span>
                </div>
                <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                  <span className="text-muted-foreground/70">Destination</span>
                  <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                    {destinationAddress || "Unavailable"}
                  </span>
                </div>
                {isExternalEvmBridge ? (
                  <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Signing wallet</span>
                    <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                      {externalWalletAddress || "Unavailable"}
                    </span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">
                      Source treasury wallet
                    </span>
                    <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                      {transferWallet?.walletAddress || "Unavailable"}
                    </span>
                  </div>
                )}
              </div>

              {isExternalEvmBridge ? (
                <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3 text-sm">
                  <p className="font-semibold text-primary/80 mb-2">3 wallet confirmations required</p>
                  <ol className="space-y-1 text-muted-foreground/80 list-none">
                    <li>① Approve USDC spend on {sourceOption.label}</li>
                    <li>② Burn USDC via CCTP V2 on {sourceOption.label}</li>
                    <li>③ Mint USDC on {destinationOption.label} (auto-switched)</li>
                  </ol>
                  <p className="mt-2 text-xs text-muted-foreground/60">
                    Estimated time: {getEstimatedBridgeTimeLabel(sourceChain, true)} including Circle attestation.
                  </p>
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                  Circle burn, attestation, and mint can take a while. The progress
                  tracker will keep updating after you submit, and you can leave the
                  page at any time.
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setIsReviewDialogOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => {
                    void submitBridge();
                  }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Route className="h-4 w-4" />
                  )}
                  {isSubmitting ? "Starting bridge..." : "Start bridge"}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isSuccessDialogOpen} onOpenChange={setIsSuccessDialogOpen}>
        <DialogContent className="glass-card max-w-md overflow-hidden border-border/40 bg-background/95 p-0">
          <div className="relative overflow-hidden p-6">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent" />
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-400 ring-1 ring-emerald-400/20">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl">Bridge completed</DialogTitle>
              <DialogDescription>
                Circle finished the bridge and the destination mint is confirmed.
              </DialogDescription>
            </DialogHeader>

            {transfer ? (
              <div className="mt-6 space-y-4">
                <div className="rounded-2xl border border-border/40 bg-background/45 p-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Route</span>
                    <span className="font-medium">
                      {transferSourceOption.label} to {transferDestinationOption.label}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Amount</span>
                    <span className="font-mono font-medium">
                      {transfer.amount} {tokenSymbol}
                    </span>
                  </div>
                  <div className="mt-3 flex items-start justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Destination</span>
                    <span className="max-w-[12rem] break-all text-right font-mono font-medium">
                      {transfer.destinationAddress || "Unavailable"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground/70">Transfer ID</span>
                    <span className="font-mono text-xs">
                      {shortenAddress(transfer.transferId)}
                    </span>
                  </div>
                </div>

                <div className="grid gap-2">
                  {burnExplorerUrl ? (
                    <Button asChild variant="outline" className="w-full">
                      <a
                        href={burnExplorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View burn tx
                      </a>
                    </Button>
                  ) : null}
                  {mintExplorerUrl ? (
                    <Button asChild variant="outline" className="w-full">
                      <a
                        href={mintExplorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View mint tx
                      </a>
                    </Button>
                  ) : null}
                </div>

                <Button
                  variant="outline"
                  className="w-full gap-2 border-[#1DA1F2]/50 text-[#1DA1F2] hover:bg-[#1DA1F2]/10"
                  asChild
                >
                  <a href={bridgeXShareUrl} target="_blank" rel="noreferrer">
                    <MessageCircle className="h-4 w-4" />
                    Share to X (Twitter)
                  </a>
                </Button>

                <Button className="w-full" onClick={() => {
                  setIsSuccessDialogOpen(false);
                  clearStoredActiveTransfer();
                  setTransfer(null);
                  setAmount("");
                  setDestinationAddress("");
                  setErrorMessage(null);
                  reconnectingPollCountRef.current = 0;
                  setIsReconnectingToTracking(false);
                  terminalNoticeRef.current = null;
                }}>
                  Start New Bridge
                </Button>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
