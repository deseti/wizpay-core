"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAddress, type Address, type Hex } from "viem";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { BackendApiError } from "@/lib/backend-api";
import {
  verifyPublicInvoicePayment,
  type PublicInvoice,
} from "@/lib/invoice-api";
import {
  buildInvoiceTransferRequest,
  clearInvoicePaymentRecovery,
  isInvoiceSelfPayment,
  readInvoicePaymentRecovery,
  writeInvoicePaymentRecovery,
  type ExternalInvoicePaymentRecovery,
} from "@/lib/invoice-payment";
import {
  acquireExecutionIntent,
  bindKnownExecutionIntentHash,
  bindExecutionIntentTransactionHash,
  cancelExecutionIntent,
  prepareWalletExecutionIntent,
} from "@/lib/execution-intent";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";
import { assertFrontendTransactionsAvailable } from "@/lib/arc-network";
import {
  assertSelectedArcWalletChain,
  requestExternalWalletChain,
} from "@/lib/external-wallet-policy";

export type InvoicePayerMethod = "app" | "external";
export type InvoicePaymentStage =
  | "ready"
  | "connecting_wallet"
  | "preparing_payment"
  | "switching_network"
  | "awaiting_signature"
  | "transaction_submitted"
  | "resolving_transaction"
  | "confirming_onchain"
  | "verifying_payment"
  | "paid"
  | "recoverable_error"
  | "terminal_error"
  | "expired"
  | "cancelled";

const MAX_AUTOMATIC_CHECKS = 24;
const CHECK_INTERVAL_MS = 5_000;
const MANUAL_THROTTLE_MS = 5_000;
const MAINNET_ONLY_MESSAGE =
  "Arc Mainnet supports external wallet payments only.";

function assertArcMainnetInvoice(invoice: PublicInvoice) {
  if (ACTIVE_ARC_NETWORK.key !== "arc-mainnet") {
    throw new TerminalInvoicePaymentError(MAINNET_ONLY_MESSAGE);
  }
  assertFrontendTransactionsAvailable(ACTIVE_ARC_NETWORK);
  if (invoice.chain.id !== ACTIVE_ARC_NETWORK.chainId) {
    throw new TerminalInvoicePaymentError(
      `This invoice targets an unsupported network (chain ${invoice.chain.id}). Arc Mainnet (chain ${ACTIVE_ARC_NETWORK.chainId}) is required.`,
    );
  }
}

export function useInvoicePayment(
  invoice: PublicInvoice,
  onInvoice: (invoice: PublicInvoice) => void,
) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [method, setMethod] = useState<InvoicePayerMethod>("external");
  const [stage, setStage] = useState<InvoicePaymentStage>(() =>
    statusStage(invoice),
  );
  const [error, setError] = useState<string | null>(null);
  const [transactionHash, setTransactionHash] = useState<Hex | null>(
    () => invoice.transactionHash,
  );
  const [externalRecovery, setExternalRecovery] =
    useState<ExternalInvoicePaymentRecovery | null>(null);
  const [checking, setChecking] = useState(false);
  const [submissionLocked, setSubmissionLocked] = useState(
    invoice.status !== "OPEN",
  );
  const inFlight = useRef(false);
  const signed = useRef(false);
  const attempts = useRef(0);
  const timer = useRef<number | null>(null);
  const lastManualCheck = useRef(0);
  const verifyRef = useRef<
    ((hash: Hex, manual?: boolean) => Promise<void>) | null
  >(null);

  const verify = useCallback(
    async (hash: Hex, manual = false) => {
      if (inFlight.current) return;
      const now = Date.now();
      if (manual && now - lastManualCheck.current < MANUAL_THROTTLE_MS) return;
      if (manual) lastManualCheck.current = now;
      inFlight.current = true;
      setChecking(true);
      setStage("verifying_payment");
      try {
        const updated = await verifyPublicInvoicePayment(
          invoice.publicId,
          hash,
        );
        onInvoice(updated);
        if (updated.status === "PAID") {
          setStage("paid");
          setError(null);
          setExternalRecovery(null);
          clearInvoicePaymentRecovery(invoice.publicId, window.localStorage);
          if (timer.current) window.clearTimeout(timer.current);
          return;
        }
        setStage(statusStage(updated));
      } catch (cause) {
        const apiError = cause instanceof BackendApiError ? cause : null;
        const retryable = apiError?.status === 429 || apiError?.status === 503;
        setError(
          cause instanceof Error
            ? cause.message
            : "Payment verification failed.",
        );
        setStage(retryable ? "recoverable_error" : "terminal_error");
        if (retryable && attempts.current < MAX_AUTOMATIC_CHECKS) {
          attempts.current += 1;
          timer.current = window.setTimeout(
            () => void verifyRef.current?.(hash),
            CHECK_INTERVAL_MS,
          );
        }
      } finally {
        inFlight.current = false;
        setChecking(false);
      }
    },
    [invoice.publicId, onInvoice],
  );

  useEffect(() => {
    verifyRef.current = verify;
  }, [verify]);

  useEffect(() => {
    const start = window.setTimeout(() => {
      const recovery = readInvoicePaymentRecovery(
        invoice.publicId,
        window.localStorage,
      );
      if (invoice.status === "PAID") {
        setTransactionHash(invoice.transactionHash);
        setSubmissionLocked(true);
        setStage("paid");
        setExternalRecovery(null);
        clearInvoicePaymentRecovery(invoice.publicId, window.localStorage);
      } else if (invoice.status === "EXPIRED") {
        setSubmissionLocked(true);
        setStage("expired");
      } else if (invoice.status === "CANCELLED") {
        setSubmissionLocked(true);
        setStage("cancelled");
      } else if (recovery?.method === "external") {
        signed.current = true;
        setMethod("external");
        setSubmissionLocked(true);
        setExternalRecovery(recovery);
        if (recovery.transactionHash) {
          setTransactionHash(recovery.transactionHash);
          setStage("confirming_onchain");
          void verify(recovery.transactionHash);
        } else {
          setStage("recoverable_error");
          setError(
            "The wallet may have broadcast this payment without returning its transaction hash. WizPay will not request another payment automatically. Bind the known hash to reconcile it, or cancel only after confirming that no transaction was broadcast.",
          );
        }
      } else if (invoice.status === "VERIFYING") {
        setSubmissionLocked(true);
        setStage("recoverable_error");
        setError(
          "A payment is already being verified. Continue from the browser that submitted it or wait for the verified status.",
        );
      }
    }, 0);
    return () => {
      window.clearTimeout(start);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [
    invoice.publicId,
    invoice.status,
    invoice.transactionHash,
    verify,
  ]);

  async function payExternal() {
    assertArcMainnetInvoice(invoice);
    if (!isConnected || !address) {
      setStage("connecting_wallet");
      throw new Error("Connect an External Wallet to pay this invoice.");
    }
    if (isInvoiceSelfPayment(address, invoice.receivingAddress)) {
      throw new TerminalInvoicePaymentError(
        "This invoice cannot be paid from the merchant's receiving wallet.",
      );
    }
    assertSelectedArcWalletChain(invoice.chain.id);
    if (chainId !== invoice.chain.id) setStage("switching_network");
    await requestExternalWalletChain({
      currentChainId: chainId,
      targetChainId: invoice.chain.id,
      switchChain: switchChainAsync,
    });
    const intent = await acquireExecutionIntent({
      network: "arc-mainnet",
      operation: invoice.settlementOperation ?? "INVOICE_SETTLEMENT",
      sourceWallet: address,
      recipient: invoice.receivingAddress,
      tokenIn: invoice.token.address,
      tokenOut: invoice.token.address,
      amountUnits: invoice.amountUnits,
      externalReference: invoice.publicId,
    });
    const leaseOwner = crypto.randomUUID();
    const recovery: ExternalInvoicePaymentRecovery = {
      version: 2,
      method: "external",
      publicId: invoice.publicId,
      executionIntentId: intent.id,
      executionIntentKey: intent.idempotencyKey,
      leaseOwner,
      payerAddress: getAddress(address),
      createdAt: new Date().toISOString(),
      stage: "awaiting_wallet_signature",
    };
    await prepareWalletExecutionIntent(
      intent.id,
      intent.idempotencyKey,
      leaseOwner,
    );
    signed.current = true;
    setSubmissionLocked(true);
    setExternalRecovery(recovery);
    writeInvoicePaymentRecovery(recovery, window.localStorage);
    setStage("awaiting_signature");
    const hash = await writeContractAsync({
      ...buildInvoiceTransferRequest({
        chainId: invoice.chain.id,
        tokenAddress: invoice.token.address,
        recipient: invoice.receivingAddress,
        amountUnits: invoice.amountUnits,
      }),
      account: getAddress(address),
    });
    await bindExecutionIntentTransactionHash(
      intent.id,
      hash,
      intent.idempotencyKey,
      leaseOwner,
    );
    setSubmissionLocked(true);
    setTransactionHash(hash);
    writeInvoicePaymentRecovery(
      { ...recovery, transactionHash: hash, stage: "confirming_onchain" },
      window.localStorage,
    );
    setExternalRecovery({
      ...recovery,
      transactionHash: hash,
      stage: "confirming_onchain",
    });
    setStage("transaction_submitted");
    attempts.current = 0;
    inFlight.current = false;
    await verify(hash);
  }

  async function pay() {
    if (inFlight.current || signed.current || invoice.status !== "OPEN") return;
    inFlight.current = true;
    try {
      setError(null);
      if (method !== "external") {
        throw new TerminalInvoicePaymentError(MAINNET_ONLY_MESSAGE);
      }
      await payExternal();
    } catch (cause) {
      const terminal = cause instanceof TerminalInvoicePaymentError;
      const message =
        cause instanceof Error
          ? cause.message
          : "Wallet payment was not submitted.";
      setError(message);
      if (!signed.current) {
        setStage(
          terminal
            ? "terminal_error"
            : method === "external" && !isConnected
              ? "connecting_wallet"
              : "recoverable_error",
        );
      }
    } finally {
      inFlight.current = false;
    }
  }

  async function recoverExternalHash(value: string) {
    if (!externalRecovery || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
      setError("Enter a complete 32-byte transaction hash.");
      return;
    }
    const hash = value as Hex;
    setChecking(true);
    try {
      await bindKnownExecutionIntentHash(
        externalRecovery.executionIntentId,
        externalRecovery.executionIntentKey,
        hash,
      );
      const next = {
        ...externalRecovery,
        transactionHash: hash,
        stage: "confirming_onchain" as const,
      };
      setExternalRecovery(next);
      setTransactionHash(hash);
      writeInvoicePaymentRecovery(next, window.localStorage);
      setError(null);
      setStage("confirming_onchain");
      await verify(hash, true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The transaction hash could not be bound safely.",
      );
      setStage("recoverable_error");
    } finally {
      setChecking(false);
    }
  }

  async function cancelExternalRecovery() {
    if (!externalRecovery || externalRecovery.transactionHash) return;
    setChecking(true);
    try {
      await cancelExecutionIntent(
        externalRecovery.executionIntentId,
        externalRecovery.executionIntentKey,
      );
      clearInvoicePaymentRecovery(invoice.publicId, window.localStorage);
      setExternalRecovery(null);
      signed.current = false;
      setSubmissionLocked(false);
      setError(null);
      setStage("ready");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The unresolved payment could not be cancelled safely.",
      );
    } finally {
      setChecking(false);
    }
  }

  function selectMethod(next: InvoicePayerMethod) {
    if (submissionLocked || signed.current || invoice.status !== "OPEN") return;
    if (next !== "external") {
      setError(MAINNET_ONLY_MESSAGE);
      return;
    }
    setMethod(next);
    setError(null);
    setStage("ready");
  }

  return {
    address,
    appAuthenticated: false,
    appWalletAddress: null as Address | null,
    authenticateAppWallet: () => {
      setError(MAINNET_ONLY_MESSAGE);
    },
    checking,
    canContinueAppAuthorization: false,
    continueAppAuthorization: () => Promise.resolve(),
    error,
    isConnected,
    externalRecoveryNeedsHash: Boolean(
      externalRecovery && !externalRecovery.transactionHash,
    ),
    recoverExternalHash,
    cancelExternalRecovery,
    locked: submissionLocked,
    method,
    pay,
    selectMethod,
    stage,
    transactionHash,
    checkStatus: () =>
      transactionHash
        ? verify(transactionHash, true)
        : Promise.resolve(),
  };
}

class TerminalInvoicePaymentError extends Error {}

function statusStage(invoice: PublicInvoice): InvoicePaymentStage {
  if (invoice.status === "PAID") return "paid";
  if (invoice.status === "EXPIRED") return "expired";
  if (invoice.status === "CANCELLED") return "cancelled";
  return invoice.status === "VERIFYING" ? "verifying_payment" : "ready";
}
