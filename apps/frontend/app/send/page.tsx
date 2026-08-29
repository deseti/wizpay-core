"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Loader2, QrCode, RefreshCw, Send } from "lucide-react";
import { formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { usePublicClient, useSwitchChain } from "wagmi";

import { DashboardAppFrame } from "@/components/dashboard/DashboardAppFrame";
import { TransactionSuccessDialog } from "@/components/dashboard/TransactionSuccessDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenIcon } from "@/components/ui/token-icon";
import { SendPageSkeleton } from "@/components/ui/skeleton-loaders";
import { useHybridWallet } from "@/components/providers/HybridWalletProvider";
import { useCircleWallet } from "@/components/providers/CircleWalletProvider";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useTransactionExecutor } from "@/hooks/useTransactionExecutor";
import { ERC20_ABI } from "@/constants/erc20";
import { parseEvmPaymentPayload } from "@/lib/evm-payment-uri";
import { extractCircleTransactionHash, verifyCircleAppWalletTransfer, verifyErc20Transfer } from "@/lib/send-transaction";
import { ARC_GAS_FALLBACK_UNITS, calculateArcMaxAmount, gasReserveFromFeeWei, hasArcGasForAmount, readCircleFeeEstimateWei } from "@/lib/arc-gas-reserve";
import { acquireSendReconciliation, archiveAndClearSendOperation, assertCircleTransactionMatches, beginReconciliation, canSafelyUnlockPreChallenge, classifySendStatusError, estimateUserTransferFee, extractSingleCorrelationId, findMatchingCircleTransactionPaginated, getUserChallengeStatus, getUserTransactionStatus, isAmbiguousChallengeCreationError, isCircleComplete, isCircleTerminalFailure, isSendOperationLocked, listActiveUserChallenges, readSendOperation, sendExecutionState, shouldPollSendOperation, withSendMetadata, writeSendOperation, type AppWalletSendOperation, type AppWalletSendStage, type SendOperationScope } from "@/lib/send-operation";
import { selectCircleTransferToken } from "@/services/circle-auth.service";
import { arcTestnet } from "@/lib/wagmi";
import { formatCompactAddress, formatTokenAmount, getExplorerTxUrl, SUPPORTED_TOKENS, TOKEN_OPTIONS, type TokenSymbol } from "@/lib/wizpay";

type SendStage = "idle" | "validating" | "awaiting_network_switch" | "awaiting_authorization" | "awaiting_signature" | "submitting" | "confirming" | "verifying" | "completed" | AppWalletSendStage;

const STAGE_COPY: Record<Exclude<SendStage, "idle" | "completed">, string> = {
  validating: "Validating transfer details",
  awaiting_network_switch: "Awaiting network switch",
  awaiting_authorization: "Authorize this transfer in your Circle wallet",
  awaiting_signature: "Confirm this transfer in your external wallet",
  submitting: "Submitting transfer",
  confirming: "Waiting for network confirmation",
  verifying: "Verifying recipient, amount, token, sender, and receipt",
  preparing: "Preparing a recoverable Circle transfer",
  challenge_created: "Circle transfer challenge created",
  awaiting_user_authorization: "Authorize the existing transfer in your Circle wallet",
  authorization_completed: "Authorization completed",
  resolving_transaction: "Resolving Circle transaction",
  transaction_pending: "Circle accepted the transfer and is processing it",
  confirming_onchain: "Waiting for on-chain confirmation",
  verifying_transfer: "Verifying the exact transfer evidence",
  status_unknown: "We could not confirm the current status yet. No new transfer can be created until this attempt is reconciled.",
  provider_unavailable: "Circle status is temporarily unavailable. No new transfer can be created until this attempt is reconciled.",
  timed_out: "Status checking timed out without proving success or failure. The existing transfer remains protected.",
  recoverable_error: "We could not confirm the current status yet. The existing transfer remains recoverable.",
  reconciling: "Checking Circle for the exact challenge or transfer before deciding whether retry is safe.",
  pre_challenge_failed: "Circle definitively rejected the request before creating a transfer. It is safe to retry.",
  terminal_error: "The transaction was confirmed as failed and no funds were transferred.",
};

function exactAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error("Enter a valid positive amount.");
  const fraction = normalized.split(".")[1] ?? "";
  if (fraction.length > decimals) throw new Error(`Amount supports at most ${decimals} decimal places.`);
  const units = parseUnits(normalized, decimals);
  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  return units;
}

function readPrefill(searchParams: URLSearchParams) {
  const rawRecipient = searchParams.get("recipient");
  if (!rawRecipient) return { recipient: "", token: "USDC" as TokenSymbol, amount: "", scanned: false, error: null as string | null };
  try {
    const queryToken = searchParams.get("token");
    const queryAmount = searchParams.get("amount");
    const queryChain = searchParams.get("chainId");
    const tokenConfig = queryToken ? SUPPORTED_TOKENS[queryToken as TokenSymbol] : undefined;
    const action = queryToken
      ? `${tokenConfig?.address ?? ""}${queryChain ? `@${queryChain}` : ""}/transfer?address=${rawRecipient}&uint256=${queryAmount && tokenConfig ? parseUnits(queryAmount, tokenConfig.decimals) : ""}`
      : `${rawRecipient}${queryChain ? `@${queryChain}` : ""}`;
    const prefill = parseEvmPaymentPayload(`ethereum:${action}`);
    return { recipient: prefill.recipient, token: prefill.token ?? "USDC", amount: prefill.amount ?? "", scanned: searchParams.get("scanned") === "1", error: null };
  } catch (cause) {
    return { recipient: "", token: "USDC" as TokenSymbol, amount: "", scanned: false, error: cause instanceof Error ? cause.message : "Invalid Send prefill." };
  }
}

function SendWorkspace() {
  const searchParams = useSearchParams();
  const initialPrefill = useMemo(() => readPrefill(new URLSearchParams(searchParams.toString())), [searchParams]);
  const wallet = useHybridWallet();
  const circle = useCircleWallet();
  const { balances, isError: balanceError, isLoading: balancesLoading, refetch } = useTokenBalances();
  const showInitialSkeleton = useDelayedLoading(balancesLoading && wallet.isActiveWalletConnected);
  const { executeTransaction } = useTransactionExecutor();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { switchChainAsync } = useSwitchChain();
  const [recipient, setRecipient] = useState(initialPrefill.recipient);
  const [tokenSymbol, setTokenSymbol] = useState<TokenSymbol>(initialPrefill.token);
  const [amount, setAmount] = useState(initialPrefill.amount);
  const [scanned, setScanned] = useState(initialPrefill.scanned);
  const [stage, setStage] = useState<SendStage>("idle");
  const [error, setError] = useState<string | null>(initialPrefill.error);
  const [verifiedHash, setVerifiedHash] = useState<Hex | null>(null);
  const [completed, setCompleted] = useState<{ amount: string; recipient: Address; token: TokenSymbol; mode: "circle" | "external" } | null>(null);
  const submittingRef = useRef(false);
  const submittedRef = useRef(false);
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const [operation, setOperation] = useState<AppWalletSendOperation | null>(null);
  const [gasReserveUnits, setGasReserveUnits] = useState(ARC_GAS_FALLBACK_UNITS);
  const [gasReserveSource, setGasReserveSource] = useState<"estimate" | "fallback">("fallback");
  const [estimatingGas, setEstimatingGas] = useState(false);
  const [lastStatusCheck, setLastStatusCheck] = useState(0);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const statusInFlightRef = useRef(false);
  const formVersion = useRef(0);
  const token = SUPPORTED_TOKENS[tokenSymbol];
  const busy = stage !== "idle" && stage !== "completed" && stage !== "terminal_error";
  const formLocked = busy || submissionLocked;

  const circleWalletId = circle.arcWallet?.id;
  const sendScope = useMemo<SendOperationScope | null>(() => {
    const userId = typeof circle.arcWallet?.userId === "string" ? circle.arcWallet.userId : null;
    if (wallet.walletMode !== "circle" || !userId || !circleWalletId || !wallet.activeWalletAddress || !isAddress(wallet.activeWalletAddress)) return null;
    return { userId, walletId: circleWalletId, sender: getAddress(wallet.activeWalletAddress), chainId: arcTestnet.id };
  }, [circle.arcWallet?.userId, circleWalletId, wallet.activeWalletAddress, wallet.walletMode]);

  useEffect(() => {
    const restored = readSendOperation(typeof window === "undefined" ? undefined : window.localStorage, sendScope);
    queueMicrotask(() => {
      setOperation(restored);
      setSubmissionLocked(Boolean(restored && isSendOperationLocked(restored.stage)));
      if (!restored) { setStage("idle"); return; }
      setRecipient(restored.recipient);
      setTokenSymbol(restored.token);
      setAmount(restored.amountDisplay);
      setVerifiedHash(restored.txHash ?? null);
      setStage(restored.stage);
      if (restored.stage === "completed" && restored.txHash) setCompleted({ amount: restored.amountDisplay, recipient: restored.recipient, token: restored.token, mode: "circle" });
    });
  }, [sendScope]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function persistOperation(next: AppWalletSendOperation) {
    const updated = withSendMetadata(next, {});
    setOperation(updated);
    writeSendOperation(typeof window === "undefined" ? undefined : window.localStorage, updated);
    setSubmissionLocked(isSendOperationLocked(updated.stage));
    setStage(updated.stage);
  }

  async function verifyRecoveredOperation(current: AppWalletSendOperation, hash: Hex) {
    if (!publicClient) throw new Error("Arc network client is unavailable.");
    const verifying = { ...current, txHash: hash, stage: "verifying_transfer" as const, lastError: undefined };
    persistOperation(verifying);
    await verifyCircleAppWalletTransfer({ amount: BigInt(current.amountUnits), hash, publicClient, recipient: current.recipient, sender: current.sender, token: current.tokenAddress, tokenSymbol: current.token });
    const done = { ...verifying, stage: "completed" as const };
    persistOperation(done);
    setVerifiedHash(hash);
    setCompleted({ amount: current.amountDisplay, recipient: current.recipient, token: current.token, mode: "circle" });
    setSubmissionLocked(false);
    await refetch();
  }

  async function checkOperationStatus(candidate = operation, manual = false) {
    if (!candidate || !circle.userToken || statusInFlightRef.current) return;
    const releaseReconciliation = acquireSendReconciliation(candidate);
    if (!releaseReconciliation) return;
    const now = Date.now();
    if (manual && now - lastStatusCheck < 5_000) {
      releaseReconciliation();
      return;
    }
    if (!manual && candidate.reconciliationDeadline && now >= Date.parse(candidate.reconciliationDeadline)) {
      persistOperation(withSendMetadata(candidate, { stage: "status_unknown", reconciliationOutcome: "deadline_reached", lastError: "Automatic reconciliation reached its bounded deadline. Use Check status to retry the read-only proof." }));
      releaseReconciliation();
      return;
    }
    statusInFlightRef.current = true;
    setCheckingStatus(true);
    if (manual) setLastStatusCheck(now);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let current = candidate;
      let transaction = null;
      if (!current.challengeId && !current.transactionId) {
        current = beginReconciliation(current);
        persistOperation(current);
        const activeChallenges = await listActiveUserChallenges(circle.userToken, controller.signal);
        if (activeChallenges.length > 0) {
          persistOperation(withSendMetadata(current, { stage: "status_unknown", reconciliationOutcome: "pending", lastError: "Circle still reports an active challenge for this user. Without the exact challenge ID, retry remains blocked." }));
          return;
        }
        transaction = await findMatchingCircleTransactionPaginated(current, circle.userToken, controller.signal);
        if (!transaction) {
          const reconciliationAge = Date.now() - Date.parse(current.reconciliationStartedAt ?? current.updatedAt);
          if (current.retryCount < 2 || reconciliationAge < 10_000) {
            persistOperation(withSendMetadata(current, { stage: "resolving_transaction", reconciliationOutcome: "pending", lastError: "No active challenge or matching transaction was found yet. WizPay will repeat the proof before unlocking." }));
            return;
          }
          const proven = withSendMetadata(current, { stage: "pre_challenge_failed", reconciliationOutcome: "proven_not_created", lastError: "Circle returned all matching transaction pages without an exact match." });
          persistOperation(proven);
          if (canSafelyUnlockPreChallenge(proven)) archiveAndClearSendOperation(window.localStorage, proven);
          setOperation(null); setSubmissionLocked(false); setStage("idle");
          setError("The earlier request was proven not to have created a Circle transfer. You can retry safely.");
          return;
        }
      } else if (current.transactionId) {
        transaction = await getUserTransactionStatus(current.transactionId, circle.userToken, controller.signal);
      } else if (current.challengeId) {
        const challenge = await getUserChallengeStatus(current.challengeId, circle.userToken, controller.signal);
        if (challenge?.id && challenge.id !== current.challengeId) throw new Error("Circle challenge identity mismatch.");
        const correlationId = extractSingleCorrelationId(challenge);
        if (correlationId) {
          current = { ...current, transactionId: correlationId, stage: "resolving_transaction", lastError: undefined };
          persistOperation(current);
          transaction = await getUserTransactionStatus(correlationId, circle.userToken, controller.signal);
        } else if (isCircleTerminalFailure(challenge?.status)) {
          persistOperation({ ...current, stage: "terminal_error", lastError: `Circle challenge ended in ${String(challenge?.status).toLowerCase()} state.` });
          setError(`Circle challenge ended in ${String(challenge?.status).toLowerCase()} state.`);
          return;
        } else if ((challenge?.status ?? "").toUpperCase() !== "COMPLETE") {
          persistOperation({ ...current, stage: "awaiting_user_authorization", lastError: undefined });
          return;
        }
      }
      if (!transaction) {
        transaction = await findMatchingCircleTransactionPaginated(current, circle.userToken, controller.signal);
      }
      if (!transaction) {
        persistOperation({ ...current, stage: "resolving_transaction", lastError: undefined });
        return;
      }
      assertCircleTransactionMatches(current, transaction);
      if (!transaction.id) throw new Error("Circle transaction is missing its identifier.");
      current = withSendMetadata(current, { transactionId: transaction.id, stage: "transaction_pending", reconciliationOutcome: "transaction_found", lastError: undefined });
      persistOperation(current);
      if (isCircleTerminalFailure(transaction.state)) {
        const message = `Circle transfer ended in ${String(transaction.state).toLowerCase()} state.`;
        persistOperation({ ...current, stage: "terminal_error", lastError: message }); setError(message); return;
      }
      if (!isCircleComplete(transaction.state) || !transaction.txHash || !/^0x[a-fA-F0-9]{64}$/.test(transaction.txHash)) return;
      const hash = transaction.txHash as Hex;
      persistOperation({ ...current, txHash: hash, stage: "confirming_onchain" });
      await verifyRecoveredOperation({ ...current, txHash: hash, stage: "confirming_onchain" }, hash);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        const message = cause instanceof Error ? cause.message : "Circle status is temporarily unavailable.";
        if (/mismatch|multiple|missing the exact/i.test(message)) {
          archiveAndClearSendOperation(window.localStorage, { ...candidate, stage: "terminal_error", lastError: message });
          setOperation(null); setSubmissionLocked(false); setStage("idle");
          setError("The saved recovery record does not belong to this wallet or exact transfer and was rejected.");
        } else if (/reverted/i.test(message)) {
          persistOperation({ ...candidate, stage: "terminal_error", lastError: message });
          setError(null);
        } else {
          persistOperation({ ...candidate, stage: classifySendStatusError(cause), lastError: message });
          setError(null);
        }
      }
    } finally {
      releaseReconciliation();
      statusInFlightRef.current = false;
      setCheckingStatus(false);
      abortRef.current = null;
    }
  }

  useEffect(() => {
    if (!operation || !circle.userToken || !shouldPollSendOperation(operation.stage) || operation.reconciliationOutcome === "deadline_reached") return;
    const initial = window.setTimeout(() => void checkOperationStatus(operation), 0);
    const timer = window.setInterval(() => void checkOperationStatus(operation), 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  // The coordinator reads the latest persisted identity; stage changes intentionally restart one bounded timer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation?.operationId, operation?.stage, operation?.transactionId, operation?.txHash, circle.userToken]);

  const balance = balances[tokenSymbol];
  const nativeUsdcBalance = balances.USDC;
  const available = useMemo(() => formatTokenAmount(balance, token.decimals), [balance, token.decimals]);

  function mutate(action: () => void) {
    if (formLocked) return;
    formVersion.current += 1;
    setError(null);
    action();
  }

  async function estimateSendGas(units: bigint, checkedRecipient: Address) {
    try {
      if (!publicClient || !wallet.activeWalletAddress) throw new Error("Arc network client is unavailable.");
      if (wallet.walletMode === "circle" && circle.authMethod !== "passkey") {
        if (!circle.arcWallet?.id || !circle.userToken) throw new Error("Circle session is unavailable.");
        const circleBalances = await circle.getWalletBalances(circle.arcWallet.id);
        const metadata = selectCircleTransferToken(circleBalances, { blockchain: "ARC-TESTNET", symbol: token.symbol, tokenAddress: token.address });
        if (!metadata?.tokenId) throw new Error("Circle token metadata is unavailable.");
        const estimate = await estimateUserTransferFee({ amounts: [formatUnits(units, token.decimals)], destinationAddress: checkedRecipient, tokenId: metadata.tokenId, walletId: circle.arcWallet.id }, circle.userToken);
        return gasReserveFromFeeWei(readCircleFeeEstimateWei(estimate));
      }
      const gas = await publicClient.estimateContractGas({ account: getAddress(wallet.activeWalletAddress), address: token.address, abi: ERC20_ABI, functionName: "transfer", args: [checkedRecipient, units] });
      const gasPrice = await publicClient.getGasPrice();
      return gasReserveFromFeeWei(gas * gasPrice);
    } catch {
      return gasReserveFromFeeWei(null);
    }
  }

  async function selectMax() {
    if (!wallet.activeWalletAddress || balance === 0n || formLocked) return;
    setEstimatingGas(true); setError(null);
    const estimateRecipient = isAddress(recipient) ? getAddress(recipient) : getAddress(wallet.activeWalletAddress);
    const reserve = await estimateSendGas(balance, estimateRecipient);
    setGasReserveUnits(reserve.reserveUnits); setGasReserveSource(reserve.source);
    const max = calculateArcMaxAmount({ inputBalance: balance, nativeUsdcBalance, reserveUnits: reserve.reserveUnits, tokenIsUsdc: token.symbol === "USDC" });
    if (max <= 0n) setError("Leave enough USDC available for network fees.");
    else setAmount(formatUnits(max, token.decimals));
    setEstimatingGas(false);
  }

  async function submit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const startedVersion = formVersion.current;
    const startedAddress = wallet.activeWalletAddress;
    const startedMode = wallet.walletMode;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setError(null);
      setStage("validating");
      if (!wallet.isReady) throw new Error("The selected wallet is still loading.");
      if (!wallet.isActiveWalletConnected || !wallet.activeWalletAddress) throw new Error("Connect the selected wallet before sending.");
      if (!publicClient) throw new Error("Arc network client is unavailable.");
      if (!isAddress(recipient)) throw new Error("Enter a valid EVM recipient address.");
      const checkedRecipient = getAddress(recipient);
      if (/^0x0{40}$/i.test(checkedRecipient)) throw new Error("The zero address cannot receive a payment.");
      const units = exactAmount(amount, token.decimals);
      if (units > balance) throw new Error(`Insufficient ${token.symbol} balance.`);
      const reserve = await estimateSendGas(units, checkedRecipient);
      setGasReserveUnits(reserve.reserveUnits); setGasReserveSource(reserve.source);
      if (!hasArcGasForAmount({ amountUnits: units, inputBalance: balance, nativeUsdcBalance, reserveUnits: reserve.reserveUnits, tokenIsUsdc: token.symbol === "USDC" })) throw new Error("Leave enough USDC available for network fees.");
      if (wallet.walletMode === "external" && wallet.activeWalletChainId !== arcTestnet.id) {
        setStage("awaiting_network_switch");
        await switchChainAsync({ chainId: arcTestnet.id });
      }
      setStage(wallet.walletMode === "circle" ? "awaiting_authorization" : "awaiting_signature");
      const idempotencyKey = crypto.randomUUID();
      const refId = `SEND-${crypto.randomUUID()}`;
      let result: Awaited<ReturnType<typeof executeTransaction>>;
      if (wallet.walletMode === "circle" && circle.authMethod !== "passkey") {
        await circle.ensureSessionReady();
        if (!circle.arcWallet?.id) throw new Error("Arc App Wallet is not ready.");
        const circleBalances = await circle.getWalletBalances(circle.arcWallet.id);
        const balanceMetadata = selectCircleTransferToken(circleBalances, { blockchain: "ARC-TESTNET", symbol: token.symbol, tokenAddress: token.address });
        if (!balanceMetadata?.tokenId) throw new Error(`${token.symbol} token metadata is unavailable for App Wallet Send.`);
        if (circle.authMethod !== "email" && circle.authMethod !== "google") throw new Error("Unsupported App Wallet session for Send.");
        const circleUserId = typeof circle.arcWallet.userId === "string" ? circle.arcWallet.userId : "";
        if (!circleUserId) throw new Error("Circle user identity is unavailable for scoped Send recovery.");
        const now = new Date().toISOString();
        let pending: AppWalletSendOperation = {
          version: 3, operationId: refId, idempotencyKey, walletMode: "circle", authMethod: circle.authMethod, userId: circleUserId,
          walletId: circle.arcWallet.id, chainId: arcTestnet.id, sender: getAddress(wallet.activeWalletAddress),
          token: token.symbol, tokenAddress: token.address, circleTokenId: balanceMetadata.tokenId,
          recipient: checkedRecipient, amountUnits: units.toString(), amountDisplay: formatUnits(units, token.decimals),
          createdAt: now, updatedAt: now, retryCount: 0, stage: "preparing",
        };
        setStage("preparing");
        let challenge: Awaited<ReturnType<typeof circle.createTransferChallenge>>;
        try {
          challenge = await circle.createTransferChallenge({ amounts: [formatUnits(units, token.decimals)], destinationAddress: checkedRecipient, feeLevel: "MEDIUM", idempotencyKey, refId, tokenId: balanceMetadata.tokenId, walletId: circle.arcWallet.id, wizpayChain: "ARC-TESTNET" });
        } catch (challengeError) {
          if (!isAmbiguousChallengeCreationError(challengeError)) {
            setStage("idle");
            throw challengeError;
          }
          pending = beginReconciliation(withSendMetadata(pending, { stage: "status_unknown", reconciliationOutcome: "pending", lastError: challengeError instanceof Error ? challengeError.message : "Challenge creation outcome is unknown." }));
          persistOperation(pending);
          setError("Circle may have received this request, but the response was not received. The attempt is protected while WizPay reconciles it.");
          return;
        }
        pending = withSendMetadata(pending, { challengeId: challenge.challengeId, stage: "challenge_created", reconciliationOutcome: "challenge_found" });
        persistOperation(pending);
        persistOperation({ ...pending, stage: "awaiting_user_authorization" });
        const circleResult = await circle.executeChallenge(challenge.challengeId);
        const directHash = extractCircleTransactionHash(circleResult);
        pending = { ...pending, txHash: directHash ?? undefined, stage: "authorization_completed" };
        submittedRef.current = true;
        persistOperation(pending);
        await checkOperationStatus(pending, true);
        return;
      } else {
        result = await executeTransaction({ abi: ERC20_ABI, args: [checkedRecipient, units], chainId: arcTestnet.id, contractAddress: token.address, functionName: "transfer", idempotencyKey, memo: `WizPay Send ${token.symbol}`, refId });
      }
      submittedRef.current = true;
      setSubmissionLocked(true);
      if (!startedAddress || startedVersion !== formVersion.current || startedMode !== wallet.walletMode || startedAddress.toLowerCase() !== wallet.activeWalletAddress?.toLowerCase()) throw new Error("Wallet or form state changed while sending. Verification stopped.");
      setStage("submitting");
      const hash = result.txHash;
      if (!hash) {
        throw new Error("The submitted transaction did not return an on-chain hash.");
      }
      setStage("confirming");
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      setStage("verifying");
      await verifyErc20Transfer({ amount: units, hash, publicClient, recipient: checkedRecipient, sender: wallet.activeWalletAddress, token: token.address });
      setVerifiedHash(hash);
      setCompleted({ amount: formatUnits(units, token.decimals), recipient: checkedRecipient, token: token.symbol, mode: wallet.walletMode });
      setStage("completed");
      await refetch();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        const message = cause instanceof Error ? cause.message : "Transfer could not be completed.";
        const recoverable = operation || readSendOperation(typeof window === "undefined" ? undefined : window.localStorage, sendScope);
        setError(recoverable ? `${message} The existing transfer remains saved; use Check status now.` : message);
      }
      if (!readSendOperation(typeof window === "undefined" ? undefined : window.localStorage, sendScope)) setStage("idle");
    } finally {
      submittingRef.current = false;
      abortRef.current = null;
    }
  }

  async function continueAuthorization() {
    if (!operation?.challengeId || !circle.userToken || statusInFlightRef.current) return;
    statusInFlightRef.current = true;
    try {
      setError(null);
      persistOperation({ ...operation, stage: "awaiting_user_authorization", lastError: undefined });
      const result = await circle.executeChallenge(operation.challengeId);
      const directHash = extractCircleTransactionHash(result);
      const authorized = { ...operation, txHash: directHash ?? operation.txHash, stage: "authorization_completed" as const, lastError: undefined };
      persistOperation(authorized);
      statusInFlightRef.current = false;
      await checkOperationStatus(authorized, true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Authorization did not complete.";
      persistOperation({ ...operation, stage: "recoverable_error", lastError: message });
      setError(`${message} The existing challenge was preserved; no new transfer was created.`);
    } finally { statusInFlightRef.current = false; }
  }

  async function recoverExistingTransfer() {
    if (wallet.walletMode !== "circle" || circle.authMethod === "passkey" || !circle.userToken || !circle.arcWallet?.id || !wallet.activeWalletAddress || statusInFlightRef.current) return;
    statusInFlightRef.current = true; setCheckingStatus(true); setError(null);
    try {
      if (!isAddress(recipient)) throw new Error("Enter the exact recipient used by the existing transfer.");
      const checkedRecipient = getAddress(recipient);
      const units = exactAmount(amount, token.decimals);
      const circleBalances = await circle.getWalletBalances(circle.arcWallet.id);
      const metadata = selectCircleTransferToken(circleBalances, { blockchain: "ARC-TESTNET", symbol: token.symbol, tokenAddress: token.address });
      if (!metadata?.tokenId) throw new Error(`${token.symbol} token metadata is unavailable.`);
      if (circle.authMethod !== "email" && circle.authMethod !== "google") throw new Error("Unsupported App Wallet session for recovery.");
      const userId = typeof circle.arcWallet.userId === "string" ? circle.arcWallet.userId : "";
      if (!userId) throw new Error("Circle user identity is unavailable for scoped recovery.");
      const now = new Date().toISOString();
      const candidate: AppWalletSendOperation = { version: 3, operationId: `RECOVER-${crypto.randomUUID()}`, idempotencyKey: "read-only-legacy-recovery", walletMode: "circle", authMethod: circle.authMethod, userId, walletId: circle.arcWallet.id, chainId: arcTestnet.id, sender: getAddress(wallet.activeWalletAddress), token: token.symbol, tokenAddress: token.address, circleTokenId: metadata.tokenId, recipient: checkedRecipient, amountUnits: units.toString(), amountDisplay: formatUnits(units, token.decimals), createdAt: now, updatedAt: now, retryCount: 0, stage: "resolving_transaction" };
      const matched = await findMatchingCircleTransactionPaginated(candidate, circle.userToken);
      if (!matched?.id) throw new Error("No unique existing Circle transaction matches those exact transfer details. Nothing was submitted or changed.");
      const recovered = { ...candidate, transactionId: matched.id };
      assertCircleTransactionMatches(recovered, matched);
      persistOperation(recovered);
      statusInFlightRef.current = false; setCheckingStatus(false);
      await checkOperationStatus(recovered, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Existing transfer could not be recovered.");
    } finally { statusInFlightRef.current = false; setCheckingStatus(false); }
  }

  function reset() {
    if (operation && operation.stage !== "completed" && operation.stage !== "terminal_error") return;
    if (operation) archiveAndClearSendOperation(typeof window === "undefined" ? undefined : window.localStorage, operation);
    setOperation(null); setRecipient(""); setAmount(""); setScanned(false); setError(null); setVerifiedHash(null); setCompleted(null); setSubmissionLocked(false); submittedRef.current = false; setStage("idle"); formVersion.current += 1;
  }

  if (showInitialSkeleton) return <SendPageSkeleton />;

  const statusStage = operation?.stage ?? (busy ? stage : null);
  const executionState = operation ? sendExecutionState(operation.stage) : null;
  const terminalFailed = executionState === "failed";
  const unavailable = executionState === "unknown" || executionState === "timeout";
  const statusTitle = terminalFailed ? "Transfer failed" : unavailable ? "Transfer status unavailable" : "Transfer in progress";

  return (
    <>
      <div className="space-y-6">
        <div><h1 className="text-2xl font-bold sm:text-3xl">Send</h1><p className="text-sm text-muted-foreground">Send one token transfer to one EVM recipient.</p></div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <Card className="glass-card border-border/40"><CardHeader><CardTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-primary" />Transfer details</CardTitle></CardHeader><CardContent className="space-y-5">
            <div className="space-y-2"><Label htmlFor="send-recipient">Recipient EVM address</Label><Input id="send-recipient" value={recipient} disabled={formLocked} onChange={(event) => mutate(() => { setRecipient(event.target.value); setScanned(false); })} placeholder="0x..." className="font-mono" />{scanned ? <p className="flex items-center gap-1.5 text-xs text-primary"><QrCode className="h-3.5 w-3.5" />Verified QR prefill — review before sending</p> : null}</div>
            <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="send-token">Token</Label><div className="relative"><TokenIcon chainId={arcTestnet.id} address={token.address} symbol={token.symbol} size={28} className="pointer-events-none absolute left-2 top-1.5 z-10" /><select id="send-token" value={tokenSymbol} disabled={formLocked} onChange={(event) => mutate(() => setTokenSymbol(event.target.value as TokenSymbol))} className="h-10 w-full rounded-md border border-input bg-background pl-11 pr-3 text-sm">{TOKEN_OPTIONS.map((option) => <option key={option.symbol} value={option.symbol}>{option.symbol} — {option.name}</option>)}</select></div></div><div className="space-y-2"><div className="flex items-center justify-between"><Label htmlFor="send-amount">Amount</Label><Button type="button" variant="ghost" size="sm" disabled={formLocked || balance === 0n || estimatingGas} onClick={() => void selectMax()}>{estimatingGas ? "Estimating…" : "Max"}</Button></div><Input id="send-amount" inputMode="decimal" value={amount} disabled={formLocked} onChange={(event) => mutate(() => setAmount(event.target.value))} placeholder="0.00" /><p className="text-xs text-muted-foreground">Max leaves at least {formatUnits(gasReserveUnits, 6)} USDC available for network fees{gasReserveSource === "fallback" ? " when a live estimate is unavailable" : ""}.</p></div></div>
            <div className="flex items-center justify-between rounded-xl border border-border/40 bg-background/30 px-4 py-3 text-sm"><span className="text-muted-foreground">Available balance</span><span className="flex items-center gap-2 font-mono"><TokenIcon chainId={arcTestnet.id} address={token.address} symbol={token.symbol} size={20} />{available} {token.symbol}</span></div>
            {balanceError ? <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-100">Balance could not be loaded. Sending is disabled until it is refreshed.</div> : null}
            {error && !operation ? <div role="alert" className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div> : null}
            {statusStage && statusStage !== "completed" ? <div role="status" className={`rounded-xl border p-4 ${terminalFailed ? "border-destructive/30 bg-destructive/10" : unavailable ? "border-amber-500/30 bg-amber-500/10" : "border-primary/25 bg-primary/10"}`}><p className={`flex items-center gap-2 font-medium ${terminalFailed ? "text-destructive" : unavailable ? "text-amber-200" : "text-primary"}`}>{terminalFailed ? <AlertTriangle className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}{statusTitle}</p><p className="mt-1 text-sm text-muted-foreground">{STAGE_COPY[statusStage as Exclude<SendStage, "idle" | "completed">]}</p>{operation && !terminalFailed ? <p className="mt-2 text-xs text-muted-foreground">The existing recovery record blocks duplicate creation. Status checks are read-only.</p> : null}<div className="mt-3 flex flex-wrap gap-2">{operation?.stage === "awaiting_user_authorization" ? <Button size="sm" onClick={() => void continueAuthorization()}>Authorize existing transfer</Button> : null}{operation && !terminalFailed ? <Button size="sm" variant="outline" disabled={checkingStatus} onClick={() => void checkOperationStatus(operation, true)}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{checkingStatus ? "Checking…" : "Check status"}</Button> : null}{terminalFailed ? <Button size="sm" variant="outline" onClick={reset}>Start over</Button> : null}</div></div> : null}
            <Button className="w-full" disabled={formLocked || terminalFailed || balancesLoading || balanceError || !wallet.isReady || !wallet.isActiveWalletConnected} onClick={() => void submit()}>{submissionLocked ? "Existing transfer is being recovered" : "Review and send"}</Button>
            {!operation && wallet.walletMode === "circle" && circle.authMethod !== "passkey" ? <Button className="w-full" variant="ghost" disabled={checkingStatus || !recipient || !amount || !circle.userToken} onClick={() => void recoverExistingTransfer()}><RefreshCw className="mr-2 h-4 w-4" />Recover an existing transfer</Button> : null}
          </CardContent></Card>
          <Card className="glass-card h-fit border-border/40"><CardHeader><CardTitle className="text-base">Transfer summary</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex justify-between gap-3"><span className="text-muted-foreground">Token</span><span className="flex items-center gap-2"><TokenIcon chainId={arcTestnet.id} address={token.address} symbol={token.symbol} size={24} />{token.symbol}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Wallet mode</span><span>{wallet.walletMode === "circle" ? "App Wallet" : "External Wallet"}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Network</span><span>Arc Testnet</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Sender</span><span className="font-mono">{wallet.activeWalletAddress ? formatCompactAddress(wallet.activeWalletAddress) : "Not connected"}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Fee / gas</span><span className="text-right">Shown by wallet when available</span></div><p className="border-t border-border/30 pt-3 text-xs text-muted-foreground">WizPay submits one ordinary transfer. No Payroll, batch, Bridge, or Swap route is used.</p></CardContent></Card>
        </div>
      </div>
      <TransactionSuccessDialog open={stage === "completed" && Boolean(completed && verifiedHash)} title="Transfer completed" description="The exact confirmed transfer and receipt evidence were verified." rows={completed ? [{ label: "Amount", value: <span className="flex items-center gap-2"><TokenIcon chainId={arcTestnet.id} address={SUPPORTED_TOKENS[completed.token].address} symbol={completed.token} size={24} />{completed.amount} {completed.token}</span> }, { label: "Recipient", value: <span className="break-all font-mono text-xs">{completed.recipient}</span> }, { label: "Sender wallet", value: completed.mode === "circle" ? "App Wallet" : "External Wallet" }, { label: "Network", value: "Arc Testnet" }] : []} transactionHash={verifiedHash ?? undefined} explorerUrl={getExplorerTxUrl(verifiedHash) ?? undefined} onDone={() => setStage("idle")} onStartAnother={reset} startAnotherLabel="Send another" />
    </>
  );
}

export default function SendPage() {
  return <DashboardAppFrame><Suspense fallback={<SendPageSkeleton />}><SendWorkspace /></Suspense></DashboardAppFrame>;
}
