"use client";

/**
 * useExternalBridge
 *
 * Handles bridge execution for users connected via external wallets.
 * EVM↔EVM uses the existing viem flow, while EVM↔Solana routes are routed
 * through modular app-kit adapters so browser wallets sign each step.
 *
 * The backend is NOT involved in the on-chain execution here, but we send
 * an audit-log call to createCircleTransfer at the end so the transfer is
 * traceable in server logs.
 */

import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import type { PublicClient, WalletClient } from "viem";

import { createCircleTransfer } from "@/lib/transfer-service";
import type { CircleTransfer, CircleTransferBlockchain } from "@/lib/transfer-service";
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
import type { InjectedSolanaWalletProvider } from "@/components/providers/SolanaWalletProvider";

import {
  retryExternalCrossChainBridge,
  submitExternalCrossChainBridge,
} from "./external/externalBridgeCrossChain";
import {
  classifyExternalBridgeRoute,
  isExternalCrossChainRoute,
} from "./external/externalBridgeRoute";
import { getOptionByChain } from "./bridge-utils";

// ─── Context type ─────────────────────────────────────────────────────────────

export interface ExternalBridgeContext {
  sourceChain: CircleTransferBlockchain;
  destinationChain: CircleTransferBlockchain;
  amount: string;
  destinationAddress: string;
  sourceTokenAddress: string | undefined;
  sourceOption: { id: CircleTransferBlockchain; label: string };
  destinationOption: { id: CircleTransferBlockchain; label: string };
  externalWalletClient: WalletClient | null | undefined;
  externalWalletAddress: Address | undefined;
  externalWalletChainId: number | undefined;
  sourcePublicClient: PublicClient | undefined;
  destPublicClient: PublicClient | undefined;
  solanaWalletProvider?: InjectedSolanaWalletProvider | null;
  solanaWalletAddress?: string | null;
  connectSolanaWallet?: () => Promise<string>;
  switchChainAsync: (params: { chainId: number }) => Promise<unknown>;
  setTransfer: React.Dispatch<React.SetStateAction<CircleTransfer | null>>;
  setIsSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setErrorMessage: React.Dispatch<React.SetStateAction<string | null>>;
  setIsReviewDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsSuccessDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toast: (opts: {
    title: string;
    description?: string;
    variant?: "destructive" | "default";
  }) => void;
  tokenSymbol: string;
  transfer: CircleTransfer | null;
}

// ─── Error normaliser ─────────────────────────────────────────────────────────

export function getExternalBridgeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const lower = raw.toLowerCase();

  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("rejected the request") ||
    (error instanceof Object &&
      "code" in error &&
      (error as { code: unknown }).code === 4001)
  ) {
    return "Transaction rejected — you cancelled the wallet confirmation. Try again when ready.";
  }

  if (
    lower.includes("insufficient funds") ||
    lower.includes("insufficient gas") ||
    lower.includes("gas required exceeds allowance")
  ) {
    return "Insufficient gas: your wallet doesn't have enough ETH/native token to pay for this transaction. Top up the wallet and retry.";
  }

  if (
    lower.includes("chain") &&
    (lower.includes("switch") || lower.includes("mismatch"))
  ) {
    return "Chain switch failed. Please manually switch your wallet to the correct network and try again.";
  }

  if (lower.includes("attestation") && lower.includes("timed out")) {
    return raw;
  }

  return raw;
}

export function asHexTxHash(value: string | null | undefined): Hex | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]+$/.test(trimmed) ? (trimmed as Hex) : null;
}

// ─── retryExternalAttestationAndMint ─────────────────────────────────────────

export async function retryExternalAttestationAndMint(
  ctx: ExternalBridgeContext
) {
  const {
    transfer,
    externalWalletClient,
    destPublicClient,
    switchChainAsync,
    setTransfer,
    setIsSubmitting,
    setErrorMessage,
    setIsSuccessDialogOpen,
    toast,
    tokenSymbol,
  } = ctx;

  if (!transfer || !transfer.transferId?.startsWith("ext-")) return;

  const srcChain = transfer.sourceBlockchain;
  const dstChain = transfer.blockchain;
  const routeKind = classifyExternalBridgeRoute(srcChain, dstChain);

  if (isExternalCrossChainRoute(routeKind)) {
    await retryExternalCrossChainBridge(ctx);
    return;
  }

  if (routeKind === "solana-to-solana") {
    setErrorMessage("External wallet bridge does not support Solana to Solana routes.");
    return;
  }

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
              s.id === "attestation"
                ? { ...s, state: "success", errorMessage: null }
                : s
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

    setIsSuccessDialogOpen(true);
    toast({
      title: "Bridge completed",
      description: `${transfer.amount} ${tokenSymbol} arrived on ${getOptionByChain(dstChain).label}.`,
    });
  } catch (error) {
    const errMsg = getExternalBridgeErrorMessage(error);
    const isAttestationTimeout =
      errMsg.toLowerCase().includes("attestation") &&
      errMsg.toLowerCase().includes("timed out");

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
      title: isAttestationTimeout
        ? "Attestation still pending"
        : "Bridge retry failed",
      description: isAttestationTimeout
        ? "Circle has not published the attestation yet."
        : errMsg,
      variant: isAttestationTimeout ? undefined : "destructive",
    });
  } finally {
    setIsSubmitting(false);
  }
}

// ─── submitExternalBridge ────────────────────────────────────────────────────

export async function submitExternalBridge(
  ctx: ExternalBridgeContext,
  clearStoredActiveTransfer: () => void
) {
  const {
    sourceChain,
    destinationChain,
    amount,
    destinationAddress,
    sourceTokenAddress,
    sourceOption,
    destinationOption,
    externalWalletClient,
    externalWalletAddress,
    sourcePublicClient,
    destPublicClient,
    switchChainAsync,
    setTransfer,
    setIsSubmitting,
    setErrorMessage,
    setIsReviewDialogOpen,
    setIsSuccessDialogOpen,
    toast,
    tokenSymbol,
  } = ctx;

  const routeKind = classifyExternalBridgeRoute(
    sourceChain,
    destinationChain
  );

  if (isExternalCrossChainRoute(routeKind)) {
    await submitExternalCrossChainBridge(ctx, clearStoredActiveTransfer);
    return;
  }

  if (routeKind === "solana-to-solana") {
    setErrorMessage(
      "External wallet bridge does not support Solana to Solana routes. Choose an EVM destination or switch to App Wallet mode."
    );
    return;
  }

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
    toast({ title: "Switching network", description: `Switching wallet to ${sourceOption.label}…` });
    await switchChainAsync({ chainId: srcChainId });

    // ── Step 2: Approve USDC spend by CCTP TokenMessenger ──
    toast({ title: "Approve USDC", description: `Approve ${amount} USDC for CCTP bridge…` });
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
    toast({ title: "Burn USDC", description: `Burning ${amount} USDC on ${sourceOption.label} via CCTP…` });
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
      description: "Circle is attesting the burn. This may take a few minutes on testnet…",
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
    toast({ title: "Switching network", description: `Switching wallet to ${destinationOption.label}…` });
    await switchChainAsync({ chainId: dstChainId });

    // ── Step 7: receiveMessage (mint) ──
    toast({ title: "Mint USDC", description: `Minting ${amount} USDC on ${destinationOption.label}…` });
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
    const auditWalletAddress = finalTransfer.walletAddress ?? walletAddress;
    try {
      await createCircleTransfer({
        sourceBlockchain: sourceChain,
        blockchain: destinationChain,
        amount,
        destinationAddress,
        tokenAddress: burnTokenAddress,
        walletAddress: auditWalletAddress,
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
