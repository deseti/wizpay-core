import {
  TransferSpeed,
  type BridgeResult,
  type BridgeStep,
} from "@circle-fin/app-kit";

import type { InjectedSolanaWalletProvider } from "@/components/providers/SolanaWalletProvider";
import { createCircleTransfer } from "@/lib/transfer-service";
import type { CircleTransfer, CircleTransferStep } from "@/lib/transfer-service";

import { clearStoredActiveTransfer } from "../bridge-storage";
import type { ExternalBridgeContext } from "../useExternalBridge";
import {
  createExternalEvmWalletAdapter,
  createExternalSolanaWalletAdapter,
} from "./externalBridgeAdapters";
import {
  getExternalBridgeAppKit,
  getExternalBridgeAppKitChain,
} from "./externalBridgeAppKit";
import {
  classifyExternalBridgeRoute,
  type ExternalBridgeRouteKind,
} from "./externalBridgeRoute";

type WalletAddresses = {
  sourceAddress: string;
  destinationWalletAddress: string;
};

function normalizeErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const lower = raw.toLowerCase();

  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("rejected the request")
  ) {
    return "Transaction rejected. Confirm the request in your wallet to continue.";
  }

  return raw;
}

function isAttestationTimeoutMessage(message: string | null | undefined) {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("attestation") && normalized.includes("timed out");
}

function createInitialTransfer(ctx: ExternalBridgeContext): CircleTransfer {
  const now = new Date().toISOString();
  const sourceAddress =
    ctx.sourceChain === "SOLANA-DEVNET"
      ? ctx.solanaWalletAddress ?? null
      : ctx.externalWalletAddress ?? null;

  return {
    id: `ext-${Date.now()}`,
    transferId: `ext-${Date.now()}`,
    stage: "burning",
    status: "processing",
    rawStatus: "burning",
    txHash: null,
    txHashBurn: null,
    txHashMint: null,
    sourceAddress,
    walletId: null,
    walletAddress: sourceAddress,
    sourceBlockchain: ctx.sourceChain,
    sourceChain: ctx.sourceChain,
    destinationChain: ctx.destinationChain,
    blockchain: ctx.destinationChain,
    destinationAddress: ctx.destinationAddress,
    amount: ctx.amount,
    tokenAddress: ctx.sourceTokenAddress ?? "",
    provider: "CCTP V2 (External Wallet)",
    referenceId: `BRIDGE-EXT-${ctx.sourceChain}-TO-${ctx.destinationChain}-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    errorReason: null,
    steps: [
      {
        id: "burn",
        name: `Burn on ${ctx.sourceOption.label}`,
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
        name: `Mint on ${ctx.destinationOption.label}`,
        state: "pending",
        txHash: null,
        explorerUrl: null,
        errorMessage: null,
      },
    ],
  };
}

function toCircleStepState(state: BridgeStep["state"]): CircleTransferStep["state"] {
  if (state === "success" || state === "noop") {
    return "success";
  }

  if (state === "error") {
    return "error";
  }

  return "pending";
}

function createDefaultSteps(ctx: ExternalBridgeContext) {
  return {
    burn: {
      id: "burn",
      name: `Burn on ${ctx.sourceOption.label}`,
      state: "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: null,
    },
    attestation: {
      id: "attestation",
      name: "Waiting for Circle attestation",
      state: "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: null,
    },
    mint: {
      id: "mint",
      name: `Mint on ${ctx.destinationOption.label}`,
      state: "pending",
      txHash: null,
      explorerUrl: null,
      errorMessage: null,
    },
  } as Record<"burn" | "attestation" | "mint", CircleTransferStep>;
}

function mapBridgeSteps(
  result: BridgeResult,
  ctx: ExternalBridgeContext
): CircleTransferStep[] {
  const mapped = createDefaultSteps(ctx);

  for (const step of result.steps) {
    const name = step.name.toLowerCase();

    if (name === "approve") {
      if (step.state === "error" && !mapped.burn.txHash) {
        mapped.burn = {
          ...mapped.burn,
          state: "error",
          errorMessage: step.errorMessage ?? "Source approval failed.",
        };
      }
      continue;
    }

    if (name === "burn") {
      mapped.burn = {
        ...mapped.burn,
        state: toCircleStepState(step.state),
        txHash: step.txHash ?? null,
        explorerUrl: step.explorerUrl ?? null,
        errorMessage: step.errorMessage ?? null,
      };
      continue;
    }

    if (name === "fetchattestation" || name === "reattest") {
      mapped.attestation = {
        ...mapped.attestation,
        state: toCircleStepState(step.state),
        errorMessage: step.errorMessage ?? null,
      };
      continue;
    }

    if (name === "mint") {
      mapped.mint = {
        ...mapped.mint,
        state: toCircleStepState(step.state),
        txHash: step.txHash ?? null,
        explorerUrl: step.explorerUrl ?? null,
        errorMessage: step.errorMessage ?? null,
      };
    }
  }

  if (result.state === "success" && mapped.attestation.state === "pending") {
    mapped.attestation = {
      ...mapped.attestation,
      state: "success",
      errorMessage: null,
    };
  }

  return [mapped.burn, mapped.attestation, mapped.mint];
}

function extractPrimaryErrorMessage(steps: CircleTransferStep[]) {
  const failedStep = [...steps].reverse().find((step) => step.state === "error");
  return failedStep?.errorMessage ?? null;
}

function mapBridgeResultToTransfer(
  result: BridgeResult,
  ctx: ExternalBridgeContext,
  baseTransfer: CircleTransfer,
  walletAddresses: WalletAddresses
): CircleTransfer {
  const steps = mapBridgeSteps(result, ctx);
  const burnStep = steps.find((step) => step.id === "burn") ?? steps[0];
  const attestationStep = steps.find((step) => step.id === "attestation") ?? steps[1];
  const mintStep = steps.find((step) => step.id === "mint") ?? steps[2];
  const primaryErrorMessage = extractPrimaryErrorMessage(steps);

  if (result.state === "success") {
    return {
      ...baseTransfer,
      stage: "completed",
      status: "settled",
      rawStatus: "completed",
      txHash: mintStep.txHash,
      txHashBurn: burnStep.txHash,
      txHashMint: mintStep.txHash,
      sourceAddress: result.source.address,
      walletAddress: result.source.address,
      errorReason: null,
      updatedAt: new Date().toISOString(),
      provider: result.provider,
      steps,
    };
  }

  if (mintStep.state === "pending") {
    return {
      ...baseTransfer,
      stage: "minting",
      status: "processing",
      rawStatus: "minting",
      txHash: burnStep.txHash,
      txHashBurn: burnStep.txHash,
      txHashMint: mintStep.txHash,
      sourceAddress: walletAddresses.sourceAddress,
      walletAddress: walletAddresses.sourceAddress,
      errorReason: null,
      updatedAt: new Date().toISOString(),
      provider: result.provider,
      steps,
    };
  }

  if (attestationStep.state === "pending") {
    return {
      ...baseTransfer,
      stage: "attesting",
      status: "processing",
      rawStatus: "attesting",
      txHash: burnStep.txHash,
      txHashBurn: burnStep.txHash,
      txHashMint: null,
      sourceAddress: walletAddresses.sourceAddress,
      walletAddress: walletAddresses.sourceAddress,
      errorReason: null,
      updatedAt: new Date().toISOString(),
      provider: result.provider,
      steps,
    };
  }

  if (burnStep.state === "pending") {
    return {
      ...baseTransfer,
      stage: "burning",
      status: "processing",
      rawStatus: "burning",
      txHash: burnStep.txHash,
      txHashBurn: burnStep.txHash,
      txHashMint: null,
      sourceAddress: walletAddresses.sourceAddress,
      walletAddress: walletAddresses.sourceAddress,
      errorReason: null,
      updatedAt: new Date().toISOString(),
      provider: result.provider,
      steps,
    };
  }

  const isRetryableAttestationFailure =
    burnStep.state === "success" &&
    (isAttestationTimeoutMessage(attestationStep.errorMessage) ||
      isAttestationTimeoutMessage(mintStep.errorMessage));

  return {
    ...baseTransfer,
    stage: isRetryableAttestationFailure ? "attesting" : "failed",
    status: isRetryableAttestationFailure ? "processing" : "failed",
    rawStatus: isRetryableAttestationFailure ? "burned" : "failed",
    txHash: mintStep.txHash ?? burnStep.txHash,
    txHashBurn: burnStep.txHash,
    txHashMint: mintStep.txHash,
    sourceAddress: walletAddresses.sourceAddress,
    walletAddress: walletAddresses.sourceAddress,
    errorReason: isRetryableAttestationFailure ? null : primaryErrorMessage,
    updatedAt: new Date().toISOString(),
    provider: result.provider,
    steps,
  };
}

async function ensureSolanaWalletProvider(
  solanaWalletProvider: InjectedSolanaWalletProvider | null | undefined,
  connectSolanaWallet: (() => Promise<string>) | undefined
) {
  if (solanaWalletProvider?.publicKey) {
    return solanaWalletProvider;
  }

  if (!solanaWalletProvider || !connectSolanaWallet) {
    throw new Error(
      "A compatible Solana wallet is required for Solana routes. Connect your Solana wallet before bridging."
    );
  }

  await connectSolanaWallet();

  if (!solanaWalletProvider.publicKey) {
    throw new Error(
      "The connected Solana wallet did not return a wallet address."
    );
  }

  return solanaWalletProvider;
}

async function buildBridgeExecution(
  ctx: ExternalBridgeContext,
  routeKind: ExternalBridgeRouteKind,
  solanaWalletProvider: InjectedSolanaWalletProvider
) {
  const sourceChain = getExternalBridgeAppKitChain(ctx.sourceChain);
  const destinationChain = getExternalBridgeAppKitChain(ctx.destinationChain);
  const evmAddress = ctx.externalWalletAddress;
  const solanaAddress = solanaWalletProvider.publicKey?.toString() ?? "";

  const publicClientsByChainId = {
    ...(ctx.sourcePublicClient?.chain?.id
      ? { [ctx.sourcePublicClient.chain.id]: ctx.sourcePublicClient }
      : {}),
    ...(ctx.destPublicClient?.chain?.id
      ? { [ctx.destPublicClient.chain.id]: ctx.destPublicClient }
      : {}),
  };

  const evmAdapter = ctx.externalWalletClient
    ? createExternalEvmWalletAdapter({
        walletClient: ctx.externalWalletClient,
        publicClientsByChainId,
      })
    : null;
  const solanaAdapter = await createExternalSolanaWalletAdapter({
    provider: solanaWalletProvider,
  });

  if (routeKind === "evm-to-solana") {
    if (!evmAdapter || !evmAddress) {
      throw new Error(
        "MetaMask or another EVM wallet must be connected before bridging from an EVM chain."
      );
    }

    return {
      source: { adapter: evmAdapter, chain: sourceChain },
      destination: {
        adapter: solanaAdapter,
        chain: destinationChain,
        recipientAddress: ctx.destinationAddress,
      },
      walletAddresses: {
        sourceAddress: evmAddress,
        destinationWalletAddress: solanaAddress,
      },
    };
  }

  if (routeKind === "solana-to-evm") {
    if (!evmAdapter || !evmAddress) {
      throw new Error(
        "MetaMask or another EVM wallet must be connected before bridging to an EVM chain."
      );
    }

    return {
      source: { adapter: solanaAdapter, chain: sourceChain },
      destination: {
        adapter: evmAdapter,
        chain: destinationChain,
        recipientAddress: ctx.destinationAddress,
      },
      walletAddresses: {
        sourceAddress: solanaAddress,
        destinationWalletAddress: evmAddress,
      },
    };
  }

  throw new Error(`Unsupported cross-chain external route: ${routeKind}`);
}

function rebuildBridgeResult(
  transfer: CircleTransfer,
  ctx: ExternalBridgeContext,
  walletAddresses: WalletAddresses
): BridgeResult {
  const steps: BridgeStep[] = transfer.steps.map((step) => {
    if (step.id === "attestation") {
      return {
        name: "fetchAttestation",
        state:
          step.state === "error"
            ? "error"
            : step.state === "success"
              ? "success"
              : "pending",
        errorMessage: step.errorMessage ?? undefined,
      };
    }

    return {
      name: step.id,
      state:
        step.state === "error"
          ? "error"
          : step.state === "success"
            ? "success"
            : "pending",
      txHash: step.txHash ?? undefined,
      explorerUrl: step.explorerUrl ?? undefined,
      errorMessage: step.errorMessage ?? undefined,
    };
  });

  return {
    amount: transfer.amount,
    token: "USDC",
    state:
      transfer.status === "settled"
        ? "success"
        : transfer.status === "processing"
          ? "pending"
          : "error",
    config: {
      transferSpeed: TransferSpeed.FAST,
      batchTransactions: false,
    },
    provider: "CCTPV2BridgingProvider",
    source: {
      address: walletAddresses.sourceAddress,
      chain: getExternalBridgeAppKitChain(transfer.sourceBlockchain),
    },
    destination: {
      address: walletAddresses.destinationWalletAddress,
      chain: getExternalBridgeAppKitChain(transfer.blockchain),
      recipientAddress: transfer.destinationAddress ?? undefined,
    },
    steps,
  };
}

async function auditExternalBridge(ctx: ExternalBridgeContext) {
  const sourceWalletAddress =
    ctx.sourceChain === "SOLANA-DEVNET"
      ? ctx.solanaWalletAddress ?? undefined
      : ctx.externalWalletAddress;

  if (!sourceWalletAddress) {
    return;
  }

  try {
    await createCircleTransfer({
      sourceBlockchain: ctx.sourceChain,
      blockchain: ctx.destinationChain,
      amount: ctx.amount,
      destinationAddress: ctx.destinationAddress,
      tokenAddress: ctx.sourceTokenAddress,
      walletAddress: sourceWalletAddress,
      bridgeExecutionMode: "external_signer",
      sourceAccountType: "external_wallet",
    });
  } catch {
    // Best-effort audit only.
  }
}

export async function submitExternalCrossChainBridge(
  ctx: ExternalBridgeContext,
  clearPersistedTransfer: () => void
) {
  const routeKind = classifyExternalBridgeRoute(
    ctx.sourceChain,
    ctx.destinationChain
  );
  const solanaWalletProvider = await ensureSolanaWalletProvider(
    ctx.solanaWalletProvider,
    ctx.connectSolanaWallet
  );
  const appKit = getExternalBridgeAppKit();
  const initialTransfer = createInitialTransfer(ctx);

  ctx.setIsSubmitting(true);
  ctx.setErrorMessage(null);
  ctx.setIsReviewDialogOpen(false);
  ctx.setTransfer(initialTransfer);

  try {
    ctx.toast({
      title: "Wallet confirmations required",
      description:
        routeKind === "evm-to-solana"
          ? `Confirm the source-side flow in your EVM wallet, then complete the destination mint in your Solana wallet.`
          : `Confirm the source-side flow in your Solana wallet, then complete the destination mint in your EVM wallet.`,
    });

    const execution = await buildBridgeExecution(
      ctx,
      routeKind,
      solanaWalletProvider
    );
    const result = await appKit.bridge({
      from: execution.source,
      to: execution.destination,
      amount: ctx.amount,
      token: "USDC",
      config: {
        transferSpeed: TransferSpeed.FAST,
        batchTransactions: false,
      },
    });
    const mappedTransfer = mapBridgeResultToTransfer(
      result,
      ctx,
      initialTransfer,
      execution.walletAddresses
    );

    ctx.setTransfer(mappedTransfer);

    if (mappedTransfer.status === "settled") {
      clearPersistedTransfer();
      await auditExternalBridge(ctx);
      ctx.setIsSuccessDialogOpen(true);
      ctx.toast({
        title: "Bridge completed",
        description: `${ctx.amount} ${ctx.tokenSymbol} arrived on ${ctx.destinationOption.label}.`,
      });
      return;
    }

    const failureMessage = mappedTransfer.errorReason;
    if (mappedTransfer.status === "failed" && failureMessage) {
      ctx.setErrorMessage(failureMessage);
      ctx.toast({
        title: "Bridge transfer failed",
        description: failureMessage,
        variant: "destructive",
      });
      return;
    }

    ctx.setErrorMessage(
      "Attestation is still pending. Retry attestation and destination mint in a few minutes."
    );
    ctx.toast({
      title: "Attestation still pending",
      description:
        "The source burn is confirmed. Retry attestation and destination mint shortly.",
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);

    ctx.setTransfer((previous) =>
      previous
        ? {
            ...previous,
            stage: "failed",
            status: "failed",
            rawStatus: "failed",
            errorReason: message,
            updatedAt: new Date().toISOString(),
            steps: previous.steps.map((step) =>
              step.state === "pending"
                ? { ...step, state: "error", errorMessage: message }
                : step
            ),
          }
        : previous
    );
    ctx.setErrorMessage(message);
    ctx.toast({
      title: "Bridge transfer failed",
      description: message,
      variant: "destructive",
    });
  } finally {
    ctx.setIsSubmitting(false);
  }
}

export async function retryExternalCrossChainBridge(
  ctx: ExternalBridgeContext
) {
  const transfer = ctx.transfer;

  if (!transfer) {
    ctx.setErrorMessage("Missing bridge state for retry.");
    return;
  }

  const routeKind = classifyExternalBridgeRoute(
    transfer.sourceBlockchain,
    transfer.blockchain
  );
  const solanaWalletProvider = await ensureSolanaWalletProvider(
    ctx.solanaWalletProvider,
    ctx.connectSolanaWallet
  );
  const appKit = getExternalBridgeAppKit();

  ctx.setIsSubmitting(true);
  ctx.setErrorMessage(null);

  try {
    const execution = await buildBridgeExecution(
      ctx,
      routeKind,
      solanaWalletProvider
    );
    const retriedResult = await appKit.retryBridge(
      rebuildBridgeResult(transfer, ctx, execution.walletAddresses),
      {
        from: execution.source.adapter,
        to: execution.destination.adapter,
      }
    );
    const mappedTransfer = mapBridgeResultToTransfer(
      retriedResult,
      ctx,
      transfer,
      execution.walletAddresses
    );

    ctx.setTransfer(mappedTransfer);

    if (mappedTransfer.status === "settled") {
      clearStoredActiveTransfer();
      ctx.setIsSuccessDialogOpen(true);
      ctx.toast({
        title: "Bridge completed",
        description: `${ctx.amount} ${ctx.tokenSymbol} arrived on ${ctx.destinationOption.label}.`,
      });
      return;
    }

    if (mappedTransfer.errorReason) {
      ctx.setErrorMessage(mappedTransfer.errorReason);
    } else {
      ctx.setErrorMessage(
        "Attestation is still pending. Retry again once Circle publishes it."
      );
    }
  } catch (error) {
    const message = normalizeErrorMessage(error);
    ctx.setErrorMessage(message);
    ctx.setTransfer((previous) =>
      previous
        ? {
            ...previous,
            stage: "failed",
            status: "failed",
            rawStatus: "failed",
            errorReason: message,
            updatedAt: new Date().toISOString(),
            steps: previous.steps.map((step) =>
              step.state === "pending"
                ? { ...step, state: "error", errorMessage: message }
                : step
            ),
          }
        : previous
    );
  } finally {
    ctx.setIsSubmitting(false);
  }
}