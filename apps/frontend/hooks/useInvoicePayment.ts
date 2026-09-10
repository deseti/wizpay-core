"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { BackendApiError } from "@/lib/backend-api";
import { resolveCanonicalAppWalletEvmAddress } from "@/lib/canonical-app-wallet";
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
  type AppWalletInvoicePaymentRecovery,
  type ExternalInvoicePaymentRecovery,
} from "@/lib/invoice-payment";
import {
  extractSingleCorrelationId,
  getUserChallengeStatus,
  getUserTransactionStatus,
  isCircleComplete,
  isCircleTerminalFailure,
  type CircleTransaction,
} from "@/lib/send-operation";
import {
  extractCircleTransactionHash,
  extractCircleTransactionId,
} from "@/lib/send-transaction";
import {
  acquireExecutionIntent,
  bindKnownExecutionIntentHash,
  bindExecutionIntentTransactionHash,
  cancelExecutionIntent,
  prepareWalletExecutionIntent,
} from "@/lib/execution-intent";
import { ACTIVE_ARC_NETWORK } from "@/lib/active-arc-network";

export type InvoicePayerMethod = "app" | "external";
export type InvoicePaymentStage =
  | "ready"
  | "authenticating_app_wallet"
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

export function useInvoicePayment(
  invoice: PublicInvoice,
  onInvoice: (invoice: PublicInvoice) => void,
) {
  const circle = useCircleWallet();
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [method, setMethod] = useState<InvoicePayerMethod>(() => {
    if (typeof window === "undefined") return "external";
    return readInvoicePaymentRecovery(invoice.publicId, window.localStorage)
      ?.method === "app"
      ? "app"
      : "external";
  });
  const [stage, setStage] = useState<InvoicePaymentStage>(() =>
    statusStage(invoice),
  );
  const [error, setError] = useState<string | null>(null);
  const [transactionHash, setTransactionHash] = useState<Hex | null>(
    () => invoice.transactionHash,
  );
  const [appRecovery, setAppRecovery] =
    useState<AppWalletInvoicePaymentRecovery | null>(null);
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
  const circleTimer = useRef<number | null>(null);
  const lastManualCheck = useRef(0);
  const verifyRef = useRef<
    ((hash: Hex, manual?: boolean) => Promise<void>) | null
  >(null);
  const checkAppRef = useRef<
    | ((
        recovery: AppWalletInvoicePaymentRecovery,
        manual?: boolean,
      ) => Promise<void>)
    | null
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
          setAppRecovery(null);
          clearInvoicePaymentRecovery(invoice.publicId, window.localStorage);
          if (timer.current) window.clearTimeout(timer.current);
          if (circleTimer.current) window.clearTimeout(circleTimer.current);
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

  const persistAppRecovery = useCallback(
    (next: AppWalletInvoicePaymentRecovery) => {
      setAppRecovery(next);
      writeInvoicePaymentRecovery(next, window.localStorage);
    },
    [],
  );

  const checkAppStatus = useCallback(
    async (candidate: AppWalletInvoicePaymentRecovery, manual = false) => {
      if (candidate.transactionHash) {
        await verify(candidate.transactionHash, manual);
        return;
      }
      if (inFlight.current) return;
      const now = Date.now();
      if (manual && now - lastManualCheck.current < MANUAL_THROTTLE_MS) return;
      if (manual) lastManualCheck.current = now;
      inFlight.current = true;
      setChecking(true);
      let resolvedHash: Hex | null = null;
      let next = candidate;
      try {
        const identity = canonicalCircleIdentity(circle);
        if (!circle.authenticated) {
          setStage("authenticating_app_wallet");
          setError("Sign in to the same App Wallet to resume this payment.");
          return;
        }
        if (!identity.address || identity.mismatch || !identity.walletId) {
          throw new TerminalInvoicePaymentError(
            "The canonical Arc App Wallet could not be resolved safely.",
          );
        }
        if (
          identity.walletId !== candidate.walletId ||
          identity.address !== candidate.payerAddress
        ) {
          throw new TerminalInvoicePaymentError(
            "The signed-in App Wallet does not match the wallet that started this payment.",
          );
        }
        if (!circle.userToken) {
          setStage("recoverable_error");
          setError(
            "This passkey payment can resume only from the browser session that created it.",
          );
          return;
        }

        setError(null);
        setStage("resolving_transaction");
        let transactionId = candidate.transactionId ?? null;
        if (!transactionId) {
          const challenge = await getUserChallengeStatus(
            candidate.challengeId,
            circle.userToken,
          );
          if (challenge?.id && challenge.id !== candidate.challengeId)
            throw new TerminalInvoicePaymentError(
              "Circle challenge identity mismatch.",
            );
          transactionId = extractSingleCorrelationId(challenge);
          if (isCircleTerminalFailure(challenge?.status)) {
            throw new TerminalInvoicePaymentError(
              `Circle authorization ended in ${String(challenge?.status).toLowerCase()} state.`,
            );
          }
          if (!transactionId) {
            const authorizationCompleted =
              candidate.stage !== "awaiting_user_authorization";
            next = {
              ...candidate,
              stage:
                authorizationCompleted ||
                (challenge?.status ?? "").toUpperCase() === "COMPLETE"
                  ? "resolving_transaction"
                  : "awaiting_user_authorization",
            };
            persistAppRecovery(next);
            setStage(
              next.stage === "awaiting_user_authorization"
                ? "awaiting_signature"
                : "resolving_transaction",
            );
            if (
              next.stage === "resolving_transaction" &&
              attempts.current < MAX_AUTOMATIC_CHECKS
            ) {
              attempts.current += 1;
              circleTimer.current = window.setTimeout(
                () => void checkAppRef.current?.(next),
                CHECK_INTERVAL_MS,
              );
            }
            return;
          }
          next = {
            ...candidate,
            transactionId,
            stage: "resolving_transaction",
          };
          persistAppRecovery(next);
        }

        const transaction = await getUserTransactionStatus(
          transactionId,
          circle.userToken,
        );
        assertAppWalletTransactionIdentity(next, transaction);
        if (isCircleTerminalFailure(transaction?.state)) {
          throw new TerminalInvoicePaymentError(
            `Circle transaction ended in ${String(transaction?.state).toLowerCase()} state.`,
          );
        }
        const hash = extractCircleTransactionHash(transaction);
        if (hash && isCircleComplete(transaction?.state)) {
          next = {
            ...next,
            transactionHash: hash,
            stage: "confirming_onchain",
          };
          persistAppRecovery(next);
          if (!next.executionIntentId || !next.executionIntentKey) {
            throw new TerminalInvoicePaymentError(
              "The durable payment intent cannot be recovered safely.",
            );
          }
          await bindExecutionIntentTransactionHash(
            next.executionIntentId,
            hash,
            next.executionIntentKey,
          );
          setTransactionHash(hash);
          setStage("confirming_onchain");
          resolvedHash = hash;
          attempts.current = 0;
          return;
        }
        next = { ...next, stage: "resolving_transaction" };
        persistAppRecovery(next);
        setStage("resolving_transaction");
        if (attempts.current < MAX_AUTOMATIC_CHECKS) {
          attempts.current += 1;
          circleTimer.current = window.setTimeout(
            () => void checkAppRef.current?.(next),
            CHECK_INTERVAL_MS,
          );
        }
      } catch (cause) {
        const terminal = cause instanceof TerminalInvoicePaymentError;
        setError(
          cause instanceof Error
            ? cause.message
            : "Circle transaction status is temporarily unavailable.",
        );
        setStage(terminal ? "terminal_error" : "recoverable_error");
        if (!terminal && attempts.current < MAX_AUTOMATIC_CHECKS) {
          attempts.current += 1;
          circleTimer.current = window.setTimeout(
            () => void checkAppRef.current?.(next),
            CHECK_INTERVAL_MS,
          );
        }
      } finally {
        inFlight.current = false;
        setChecking(false);
        if (resolvedHash) void verifyRef.current?.(resolvedHash);
      }
    },
    [circle, persistAppRecovery, verify],
  );

  useEffect(() => {
    verifyRef.current = verify;
    checkAppRef.current = checkAppStatus;
  }, [checkAppStatus, verify]);

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
        setAppRecovery(null);
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
      } else if (recovery?.method === "app") {
        signed.current = true;
        setMethod("app");
        setSubmissionLocked(true);
        setAppRecovery(recovery);
        if (recovery.transactionHash) {
          setTransactionHash(recovery.transactionHash);
          setStage("confirming_onchain");
          void verify(recovery.transactionHash);
        } else if (recovery.stage === "awaiting_user_authorization") {
          setStage("awaiting_signature");
        } else {
          void checkAppStatus(recovery);
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
      if (circleTimer.current) window.clearTimeout(circleTimer.current);
    };
  }, [
    checkAppStatus,
    invoice.publicId,
    invoice.status,
    invoice.transactionHash,
    verify,
  ]);

  async function payExternal() {
    if (!isConnected || !address) {
      setStage("connecting_wallet");
      throw new Error("Connect an External Wallet to pay this invoice.");
    }
    if (isInvoiceSelfPayment(address, invoice.receivingAddress)) {
      throw new TerminalInvoicePaymentError(
        "This invoice cannot be paid from the merchant's receiving wallet.",
      );
    }
    if (chainId !== invoice.chain.id) {
      setStage("switching_network");
      await switchChainAsync({ chainId: invoice.chain.id });
    }
    const intent = await acquireExecutionIntent({
      network: ACTIVE_ARC_NETWORK.key,
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
    const hash = await writeContractAsync(
      buildInvoiceTransferRequest({
        chainId: invoice.chain.id,
        tokenAddress: invoice.token.address,
        recipient: invoice.receivingAddress,
        amountUnits: invoice.amountUnits,
      }),
    );
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

  async function payAppWallet() {
    if (!circle.authenticated) {
      setStage("authenticating_app_wallet");
      circle.login();
      return;
    }
    setStage("preparing_payment");
    await circle.ensureSessionReady();
    const identity = canonicalCircleIdentity(circle);
    if (identity.mismatch) {
      throw new TerminalInvoicePaymentError(
        "The canonical Arc App Wallet could not be resolved safely.",
      );
    }
    if (!identity.address || !identity.walletId)
      throw new Error("The Arc App Wallet is not ready yet.");
    if (isInvoiceSelfPayment(identity.address, invoice.receivingAddress)) {
      throw new TerminalInvoicePaymentError(
        "This invoice cannot be paid from the merchant's receiving wallet.",
      );
    }
    if (!circle.authMethod)
      throw new Error("The App Wallet authentication method is unavailable.");
    const transfer = buildInvoiceTransferRequest({
      chainId: invoice.chain.id,
      tokenAddress: invoice.token.address,
      recipient: invoice.receivingAddress,
      amountUnits: invoice.amountUnits,
    });
    const intent = await acquireExecutionIntent({
      network: ACTIVE_ARC_NETWORK.key,
      operation: invoice.settlementOperation ?? "INVOICE_SETTLEMENT",
      sourceWallet: identity.address,
      recipient: invoice.receivingAddress,
      tokenIn: invoice.token.address,
      tokenOut: invoice.token.address,
      amountUnits: invoice.amountUnits,
      externalReference: invoice.publicId,
    });
    const challenge = intent.circleChallengeId
      ? {
          challengeId: intent.circleChallengeId,
          raw: { challengeId: intent.circleChallengeId },
        }
      : await circle.createContractExecutionChallenge({
          walletId: identity.walletId,
          contractAddress: transfer.address,
          callData: encodeFunctionData({
            abi: transfer.abi,
            functionName: transfer.functionName,
            args: transfer.args,
          }),
          feeLevel: "MEDIUM",
          idempotencyKey: intent.idempotencyKey,
          refId: `INV-${invoice.publicId}`,
          executionIntentId: intent.id,
        });
    const recovery: AppWalletInvoicePaymentRecovery = {
      version: 2,
      method: "app",
      publicId: invoice.publicId,
      executionIntentId: intent.id,
      executionIntentKey: intent.idempotencyKey,
      authMethod: circle.authMethod,
      walletId: identity.walletId,
      payerAddress: identity.address,
      challengeId: challenge.challengeId,
      transactionId: extractCircleTransactionId(challenge.raw) ?? undefined,
      transactionHash: extractCircleTransactionHash(challenge.raw) ?? undefined,
      createdAt: new Date().toISOString(),
      stage: "awaiting_user_authorization",
    };
    signed.current = true;
    setSubmissionLocked(true);
    persistAppRecovery(recovery);
    inFlight.current = false;
    await authorizeAppWallet(recovery);
  }

  async function authorizeAppWallet(recovery = appRecovery): Promise<void> {
    if (!recovery || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setError(null);
    setStage("awaiting_signature");
    try {
      const result = await circle.executeChallenge(recovery.challengeId);
      const hash =
        extractCircleTransactionHash(result) ?? recovery.transactionHash;
      const next: AppWalletInvoicePaymentRecovery = {
        ...recovery,
        transactionId:
          extractCircleTransactionId(result) ?? recovery.transactionId,
        transactionHash: hash,
        stage: hash ? "confirming_onchain" : "authorization_completed",
      };
      persistAppRecovery(next);
      if (hash) {
        if (next.executionIntentId)
          await bindExecutionIntentTransactionHash(
            next.executionIntentId,
            hash,
            next.executionIntentKey ?? "",
          );
        setTransactionHash(hash);
        setStage("transaction_submitted");
      } else setStage("resolving_transaction");
      inFlight.current = false;
      setChecking(false);
      if (hash) await verify(hash);
      else await checkAppStatus(next);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "App Wallet authorization was not completed.",
      );
      setStage("recoverable_error");
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }

  async function pay() {
    if (inFlight.current || signed.current || invoice.status !== "OPEN") return;
    inFlight.current = true;
    try {
      setError(null);
      if (method === "app") await payAppWallet();
      else await payExternal();
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
    setMethod(next);
    setError(null);
    setStage("ready");
  }

  return {
    address,
    appAuthenticated: circle.authenticated,
    appWalletAddress: canonicalCircleIdentity(circle).address,
    authenticateAppWallet: () => {
      if (submissionLocked && !appRecovery) return;
      setStage("authenticating_app_wallet");
      circle.login();
    },
    checking,
    canContinueAppAuthorization:
      appRecovery?.stage === "awaiting_user_authorization",
    continueAppAuthorization: () => authorizeAppWallet(),
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
        : appRecovery
          ? checkAppStatus(appRecovery, true)
          : Promise.resolve(),
  };
}

function canonicalCircleIdentity(circle: ReturnType<typeof useCircleWallet>): {
  address: Address | null;
  mismatch: boolean;
  walletId: string | null;
} {
  const canonical = resolveCanonicalAppWalletEvmAddress(
    circle.arcWallet?.address,
    circle.sepoliaWallet?.address,
    circle.primaryWallet?.address,
  );
  const arcWalletIsCanonical =
    circle.arcWallet?.blockchain === "ARC-TESTNET" &&
    Boolean(circle.arcWallet.id);
  return {
    address: canonical.address,
    mismatch: canonical.mismatch,
    walletId: arcWalletIsCanonical ? (circle.arcWallet?.id ?? null) : null,
  };
}

function assertAppWalletTransactionIdentity(
  recovery: AppWalletInvoicePaymentRecovery,
  transaction: CircleTransaction | null,
) {
  if (!transaction) return;
  if (transaction.operation && transaction.operation !== "CONTRACT_EXECUTION")
    throw new TerminalInvoicePaymentError(
      "Circle transaction operation mismatch.",
    );
  if (transaction.blockchain && transaction.blockchain !== "ARC-TESTNET")
    throw new TerminalInvoicePaymentError("Circle transaction chain mismatch.");
  if (transaction.walletId && transaction.walletId !== recovery.walletId)
    throw new TerminalInvoicePaymentError(
      "Circle transaction wallet mismatch.",
    );
  if (
    transaction.sourceAddress &&
    getAddress(transaction.sourceAddress) !== recovery.payerAddress
  )
    throw new TerminalInvoicePaymentError(
      "Circle transaction sender mismatch.",
    );
}

class TerminalInvoicePaymentError extends Error {}

function statusStage(invoice: PublicInvoice): InvoicePaymentStage {
  if (invoice.status === "PAID") return "paid";
  if (invoice.status === "EXPIRED") return "expired";
  if (invoice.status === "CANCELLED") return "cancelled";
  return invoice.status === "VERIFYING" ? "verifying_payment" : "ready";
}
