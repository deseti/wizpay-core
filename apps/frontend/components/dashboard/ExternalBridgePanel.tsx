"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BRIDGE_TESTNETS,
  assertBridgeRoute,
  type BridgeTestnetCode,
} from "@wizpay/bridge-registry";
import { ArrowRightLeft, ExternalLink, ShieldCheck } from "lucide-react";
import {
  formatUnits,
  isAddressEqual,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_BRIDGE_AMOUNT, parseBridgeAmount } from "@/lib/bridge-amount";
import {
  createBridgePublicClient,
  createBridgePublicClients,
  getBridgeRegistryEntry,
  resolveBridgeRpcUrl,
  switchBridgeWalletChain,
} from "@/lib/bridge-client-readiness";
import {
  CctpFeeError,
  createCctpFeeRequestCoordinator,
  resolveStandardCctpFee,
} from "@/lib/cctp-fee";
import {
  CCTP_ERC20_ABI,
  CCTP_MESSAGE_TRANSMITTER_V2_ABI,
  CCTP_TOKEN_MESSENGER_V2_ABI,
  addressToBytes32,
  buildExplorerTransactionUrl,
  clearDirectBridgeRecovery,
  discoverDestinationCompletion,
  fetchIrisMessages,
  persistDestinationTransactionHash,
  readDirectBridgeRecovery,
  readNonceState,
  submitAndVerifyDestinationMint,
  validateBridgeRequest,
  verifyKnownDestinationCompletion,
  verifySourceTransfer,
  withBridgeSubmissionLock,
  writeDirectBridgeRecovery,
  type DirectBridgeRecovery,
  type VerifiedSourceTransfer,
} from "@/lib/cctp-v2";
import { CHAIN_BY_ID } from "@/lib/wagmi";
import { getFriendlyErrorMessage } from "@/lib/wizpay";
import { BridgeSuccessDialog } from "./BridgeSuccessDialog";
import {
  ExternalBridgeProgress,
  type BridgeProgressCondition,
  type BridgeProgressStage,
} from "./ExternalBridgeProgress";

type BridgeStage =
  | "idle"
  | "checking_allowance"
  | "awaiting_approval_signature"
  | "confirming_approval"
  | "awaiting_burn_signature"
  | "confirming_source_burn"
  | "waiting_for_attestation"
  | "attestation_ready"
  | "switching_destination_chain"
  | "awaiting_mint_signature"
  | "confirming_destination_mint"
  | "verifying_completion"
  | "completed"
  | "failed";

const ARC_CODE: BridgeTestnetCode = "ARC-TESTNET";
const ZERO_NONCE = 0n;
const POLL_DELAYS = [0, 2_000, 3_000, 5_000, 8_000, 13_000, 21_000];
const NEXT_POLL_CYCLE_DELAY = 15_000;
const MANUAL_CHECK_THROTTLE = 60_000;

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Bridge status check aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

function isWalletRejection(cause: unknown) {
  const value = cause as { code?: number; message?: string } | null;
  return (
    value?.code === 4001 ||
    /user rejected|user denied/i.test(value?.message ?? "")
  );
}

function isAbortError(cause: unknown) {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

function isRetryableProviderError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /temporarily unavailable|timed? ?out|timeout|rate limit|429|network error|failed to fetch|fetch failed|request failed|could not be found|transaction .*not found|receipt .*not found|rpc/i.test(
    message,
  );
}

function retryableCondition(cause: unknown): BridgeProgressCondition {
  const message = getFriendlyErrorMessage(cause);
  return {
    tone: "retryable",
    message: `${message} WizPay will keep the confirmed burn active and check again automatically.`,
  };
}

export function ExternalBridgePanel({
  walletAddress,
}: {
  walletAddress: Address;
}) {
  const { address: connectedAddress } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const [sourceCode, setSourceCode] = useState<BridgeTestnetCode>(ARC_CODE);
  const [destinationCode, setDestinationCode] =
    useState<BridgeTestnetCode>("BASE-SEPOLIA");
  const [amount, setAmount] = useState(DEFAULT_BRIDGE_AMOUNT);
  const [maxFee, setMaxFee] = useState<bigint | null>(null);
  const [feeStatus, setFeeStatus] = useState<
    "idle" | "pending" | "ready" | "error"
  >("idle");
  const [feeError, setFeeError] = useState<string | null>(null);
  const [feeRetry, setFeeRetry] = useState(0);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [stage, setStage] = useState<BridgeStage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progressCondition, setProgressCondition] =
    useState<BridgeProgressCondition>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [nextManualCheckAt, setNextManualCheckAt] = useState(0);
  const [manualCheckClock, setManualCheckClock] = useState(() => Date.now());
  const [recovery, setRecovery] = useState<DirectBridgeRecovery | null>(null);
  const [transfer, setTransfer] = useState<VerifiedSourceTransfer | null>(null);
  const [nonceUsed, setNonceUsed] = useState<bigint | null>(null);
  const [destinationHash, setDestinationHash] = useState<Hex | null>(null);
  const [pendingSourceHash, setPendingSourceHash] = useState<Hex | null>(null);
  const [sourceSubmittedAt, setSourceSubmittedAt] = useState<string | null>(
    null,
  );
  const [successOpen, setSuccessOpen] = useState(false);
  const [recoverySourceCode, setRecoverySourceCode] =
    useState<BridgeTestnetCode>(ARC_CODE);
  const [recoveryHash, setRecoveryHash] = useState("");
  const mounted = useRef(true);
  const feeCoordinator = useRef(createCctpFeeRequestCoordinator());
  const recoveryRun = useRef<Promise<void> | null>(null);
  const recoveryAbort = useRef<AbortController | null>(null);
  const recoveryTimer = useRef<number | null>(null);

  const source = getBridgeRegistryEntry(sourceCode);
  const destination = getBridgeRegistryEntry(destinationCode);
  const sourceClient = useMemo(
    () => createBridgePublicClient(source, resolveBridgeRpcUrl(source)),
    [source],
  );
  const destinationClient = useMemo(
    () =>
      createBridgePublicClient(destination, resolveBridgeRpcUrl(destination)),
    [destination],
  );
  const parsedAmount = useMemo(() => parseBridgeAmount(amount), [amount]);
  const amountUnits = parsedAmount.amountUnits;
  const amountLocked = Boolean(recovery || transfer) || stage !== "idle";
  const busy = ![
    "idle",
    "attestation_ready",
    "completed",
    "failed",
  ].includes(stage);
  const destinationOptions =
    sourceCode === ARC_CODE
      ? BRIDGE_TESTNETS.filter((network) => network.code !== ARC_CODE)
      : [getBridgeRegistryEntry(ARC_CODE)!];

  function clearScheduledRecovery() {
    if (recoveryTimer.current !== null) {
      window.clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
    }
  }

  function scheduleRecovery(
    sourceSelection: BridgeTestnetCode,
    hash: Hex,
  ) {
    clearScheduledRecovery();
    if (!mounted.current) return;
    recoveryTimer.current = window.setTimeout(() => {
      recoveryTimer.current = null;
      void recover(sourceSelection, hash);
    }, NEXT_POLL_CYCLE_DELAY);
  }

  function recover(sourceSelection: BridgeTestnetCode, hash: Hex) {
    if (recoveryRun.current) return recoveryRun.current;

    const run = (async () => {
      const recoverySource = getBridgeRegistryEntry(sourceSelection);
      const recoveryClient = createBridgePublicClient(
        recoverySource,
        resolveBridgeRpcUrl(recoverySource),
      );
      if (!recoverySource || !recoveryClient)
        throw new Error("The selected recovery source RPC is unavailable.");
      const controller = new AbortController();
      recoveryAbort.current = controller;
      setCheckingStatus(true);
      setError(null);
      setProgressCondition(null);
      setStage((current) =>
        current === "confirming_destination_mint" ||
        current === "verifying_completion"
          ? current
          : "waiting_for_attestation",
      );

      for (const delay of POLL_DELAYS) {
        if (delay) await wait(delay, controller.signal);
        let iris;
        try {
          iris = await fetchIrisMessages(
            recoverySource.cctpDomain,
            hash,
            controller.signal,
          );
        } catch (cause) {
          if (isAbortError(cause)) throw cause;
          if (!isRetryableProviderError(cause)) throw cause;
          if (mounted.current) setProgressCondition(retryableCondition(cause));
          continue;
        }
        if (iris.state === "pending") {
          if (mounted.current) setProgressCondition(null);
          continue;
        }
        const verified = await verifySourceTransfer({
          sourceClient: recoveryClient,
          source: recoverySource,
          sourceTransactionHash: hash,
          irisMessages: iris.messages,
        });
        const destinationReadClients = createBridgePublicClients(
          verified.destination,
        );
        const destinationReadClient = destinationReadClients[0];
        if (!destinationReadClient || !destinationReadClients.length)
          throw new Error("The attested destination RPC is unavailable.");
        const used = await readNonceState(
          destinationReadClient,
          verified.destination,
          verified.decoded.nonce,
        );
        const storedRecord = readDirectBridgeRecovery();
        const record =
          storedRecord?.sourceTransactionHash.toLowerCase() ===
          hash.toLowerCase()
            ? {
                ...storedRecord,
                amountUnits:
                  storedRecord.amountUnits ?? verified.decoded.amount.toString(),
              }
            : verified.recovery;
        writeDirectBridgeRecovery(record);
        if (!mounted.current) return;
        setRecovery(record);
        setTransfer(verified);
        setNonceUsed(used);
        setSourceCode(verified.source.code);
        setDestinationCode(verified.destination.code);
        setAmount(
          formatUnits(verified.decoded.amount, verified.source.usdcDecimals),
        );
        setProgressCondition(null);
        if (record.destinationTransactionHash) {
          setStage("confirming_destination_mint");
          const completed = await verifyKnownDestinationCompletion(
            destinationReadClients,
            verified,
            record.destinationTransactionHash,
          );
          setStage("verifying_completion");
          setDestinationHash(completed.destinationTransactionHash);
          setNonceUsed(completed.nonceState);
          setStage("completed");
          setSuccessOpen(true);
        } else if (used === ZERO_NONCE) {
          setStage("attestation_ready");
        } else {
          setStage("verifying_completion");
          const completed = await discoverDestinationCompletion(
            destinationReadClients,
            verified,
          );
          const completedRecovery = persistDestinationTransactionHash(
            record,
            completed.destinationTransactionHash,
          );
          setRecovery(completedRecovery);
          setDestinationHash(completed.destinationTransactionHash);
          setNonceUsed(completed.nonceState);
          setStage("completed");
          setSuccessOpen(true);
        }
        return;
      }

      if (mounted.current) {
        setStage("waiting_for_attestation");
        setProgressCondition(null);
      }
      scheduleRecovery(sourceSelection, hash);
    })()
      .catch((cause) => {
        if (!mounted.current || isAbortError(cause)) return;
        if (isRetryableProviderError(cause)) {
          setProgressCondition(retryableCondition(cause));
          const storedRecord = readDirectBridgeRecovery();
          setStage(
            storedRecord?.destinationTransactionHash
              ? "confirming_destination_mint"
              : "waiting_for_attestation",
          );
          scheduleRecovery(sourceSelection, hash);
          return;
        }
        setStage("failed");
        setProgressCondition({
          tone: "failed",
          message: getFriendlyErrorMessage(cause),
        });
      })
      .finally(() => {
        recoveryRun.current = null;
        recoveryAbort.current = null;
        if (mounted.current) setCheckingStatus(false);
      });

    recoveryRun.current = run;
    return run;
  }

  useEffect(() => {
    mounted.current = true;
    const stored = readDirectBridgeRecovery();
    if (stored) {
      const storedSource = BRIDGE_TESTNETS.find(
        (network) => network.chainId === stored.sourceChainId,
      );
      const storedDestination = BRIDGE_TESTNETS.find(
        (network) => network.chainId === stored.destinationChainId,
      );
      if (storedSource && storedDestination) {
        void Promise.resolve().then(() => {
          if (!mounted.current) return;
          setRecovery(stored);
          setRecoverySourceCode(storedSource.code);
          setRecoveryHash(stored.sourceTransactionHash);
          setSourceCode(storedSource.code);
          setDestinationCode(storedDestination.code);
          if (stored.amountUnits) {
            setAmount(
              formatUnits(BigInt(stored.amountUnits), storedSource.usdcDecimals),
            );
          }
          void recover(storedSource.code, stored.sourceTransactionHash);
        });
      }
    }
    return () => {
      mounted.current = false;
      clearScheduledRecovery();
      recoveryAbort.current?.abort();
    };
    // Recovery is intentionally wallet-independent and runs once after hydration.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- recovery is intentionally wallet-independent and hydrates once.

  useEffect(() => {
    if (nextManualCheckAt <= Date.now()) return;
    const timer = window.setInterval(
      () => setManualCheckClock(Date.now()),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [nextManualCheckAt]);

  useEffect(() => {
    if (!source || !sourceClient || !connectedAddress || amountLocked) return;
    let active = true;
    void sourceClient
      .readContract({
        address: source.usdcAddress,
        abi: CCTP_ERC20_ABI,
        functionName: "balanceOf",
        args: [connectedAddress],
      })
      .then((nextBalance) => {
        if (!active) return;
        setBalance(nextBalance);
      })
      .catch(() => {
        if (!active) return;
        setBalance(null);
      });
    return () => {
      active = false;
    };
  }, [amountLocked, connectedAddress, source, sourceClient]);

  useEffect(() => {
    const coordinator = feeCoordinator.current;
    if (!source || !destination || !amountUnits || amountLocked) return;
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active) return null;
        setMaxFee(null);
        setFeeError(null);
        setFeeStatus("pending");
        return coordinator.run({
          sourceCode,
          destinationCode,
          amount: amountUnits,
        });
      })
      .then((outcome) => {
        if (!active || !outcome || outcome.state !== "current") return;
        setMaxFee(outcome.result.maxFee);
        setFeeStatus("ready");
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof CctpFeeError && cause.code === "ABORTED") return;
        setMaxFee(null);
        setFeeError(getFriendlyErrorMessage(cause));
        setFeeStatus("error");
      });
    return () => {
      active = false;
      coordinator.cancel();
    };
  }, [
    amountLocked,
    amountUnits,
    destination,
    destinationCode,
    feeRetry,
    source,
    sourceCode,
  ]);

  async function requireSigner(expectedAddress: Address, chainId: number) {
    if (!connectedAddress || !walletClient?.account?.address)
      throw new Error("Reconnect the external wallet before signing.");
    if (
      !isAddressEqual(connectedAddress, expectedAddress) ||
      !isAddressEqual(walletClient.account.address, expectedAddress)
    )
      throw new Error("The connected wallet does not own this CCTP transfer.");
    await switchBridgeWalletChain({
      targetChainId: chainId,
      switchChain: switchChainAsync,
    });
    return walletClient;
  }

  async function handleStart() {
    setError(null);
    setProgressCondition(null);
    try {
      await withBridgeSubmissionLock(async () => {
        if (recovery || transfer)
          throw new Error(
            "A confirmed source burn is already recoverable. Complete it before starting another transfer.",
          );
        if (
          !source ||
          !destination ||
          !sourceClient ||
          !amountUnits ||
          maxFee === null
        )
          throw new Error(
            "The route, amount, source RPC, or current CCTP fee is not ready.",
          );
        const request = validateBridgeRequest({
          sourceCode,
          destinationCode,
          walletAddress,
          recipientAddress: walletAddress,
          amount: amountUnits,
          maxFee,
        });
        const signer = await requireSigner(
          request.walletAddress,
          request.source.chainId,
        );
        setStage("checking_allowance");
        const [decimals, currentBalance, allowance, currentFee] =
          await Promise.all([
            sourceClient.readContract({
              address: request.source.usdcAddress,
              abi: CCTP_ERC20_ABI,
              functionName: "decimals",
            }),
            sourceClient.readContract({
              address: request.source.usdcAddress,
              abi: CCTP_ERC20_ABI,
              functionName: "balanceOf",
              args: [request.walletAddress],
            }),
            sourceClient.readContract({
              address: request.source.usdcAddress,
              abi: CCTP_ERC20_ABI,
              functionName: "allowance",
              args: [request.walletAddress, request.source.tokenMessengerV2],
            }),
            resolveStandardCctpFee(
              {
                sourceCode: request.source.code,
                destinationCode: request.destination.code,
                amount: request.amount,
              },
              { forceRefresh: true },
            ),
          ]);
        if (decimals !== request.source.usdcDecimals)
          throw new Error(
            "Source USDC decimals do not match the official registry.",
          );
        if (currentBalance < request.amount)
          throw new Error("Insufficient source USDC balance.");
        if (currentFee.maxFee !== request.maxFee)
          throw new Error(
            "The CCTP fee changed; review the current amount again.",
          );
        if (allowance < request.amount) {
          setStage("awaiting_approval_signature");
          const approvalHash = await signer.writeContract({
            account: request.walletAddress,
            chain: CHAIN_BY_ID[request.source.chainId],
            address: request.source.usdcAddress,
            abi: CCTP_ERC20_ABI,
            functionName: "approve",
            args: [request.source.tokenMessengerV2, request.amount],
          });
          setStage("confirming_approval");
          const approvalReceipt = await sourceClient.waitForTransactionReceipt({
            hash: approvalHash,
          });
          if (approvalReceipt.status !== "success")
            throw new Error("The source approval reverted.");
        }
        setStage("awaiting_burn_signature");
        const sourceTransactionHash = await signer.writeContract({
          account: request.walletAddress,
          chain: CHAIN_BY_ID[request.source.chainId],
          address: request.source.tokenMessengerV2,
          abi: CCTP_TOKEN_MESSENGER_V2_ABI,
          functionName: "depositForBurn",
          args: [
            request.amount,
            request.destination.cctpDomain,
            addressToBytes32(request.recipientAddress),
            request.source.usdcAddress,
            addressToBytes32(request.walletAddress),
            request.maxFee,
            request.source.finalityThreshold,
          ],
        });
        const submittedAt = new Date().toISOString();
        setPendingSourceHash(sourceTransactionHash);
        setSourceSubmittedAt(submittedAt);
        setStage("confirming_source_burn");
        const sourceReceipt = await sourceClient.waitForTransactionReceipt({
          hash: sourceTransactionHash,
        });
        if (sourceReceipt.status !== "success")
          throw new Error("The CCTP source burn reverted.");
        const record: DirectBridgeRecovery = {
          cctpVersion: 2,
          sourceChainId: request.source.chainId,
          sourceDomain: request.source.cctpDomain,
          destinationChainId: request.destination.chainId,
          destinationDomain: request.destination.cctpDomain,
          sourceTransactionHash,
          walletAddress: request.walletAddress,
          createdAt: submittedAt,
          amountUnits: request.amount.toString(),
        };
        writeDirectBridgeRecovery(record);
        setRecovery(record);
        setPendingSourceHash(null);
        setRecoverySourceCode(request.source.code);
        setRecoveryHash(sourceTransactionHash);
        await recover(request.source.code, sourceTransactionHash);
      });
    } catch (cause) {
      setPendingSourceHash(null);
      setSourceSubmittedAt(null);
      setStage(recovery ? "failed" : "idle");
      setError(
        isWalletRejection(cause)
          ? "The wallet request was rejected. No additional bridge transaction was sent."
          : getFriendlyErrorMessage(cause),
      );
    }
  }

  async function handleRecover() {
    setError(null);
    setProgressCondition(null);
    if (!isHex(recoveryHash, { strict: true }) || recoveryHash.length !== 66) {
      setError("Enter a valid 32-byte source burn transaction hash.");
      return;
    }
    try {
      await recover(recoverySourceCode, recoveryHash);
    } catch (cause) {
      setStage("failed");
      setProgressCondition({
        tone: "failed",
        message: getFriendlyErrorMessage(cause),
      });
    }
  }

  function handleManualStatusCheck() {
    const now = Date.now();
    if (
      now < nextManualCheckAt ||
      checkingStatus ||
      !recovery?.sourceTransactionHash
    )
      return;
    setNextManualCheckAt(now + MANUAL_CHECK_THROTTLE);
    setManualCheckClock(now);
    clearScheduledRecovery();
    void recover(sourceCode, recovery.sourceTransactionHash);
  }

  async function handleMint() {
    if (
      !transfer ||
      !destinationClient ||
      nonceUsed !== ZERO_NONCE ||
      recovery?.destinationTransactionHash
    )
      return;
    setError(null);
    try {
      await withBridgeSubmissionLock(async () => {
        setStage("switching_destination_chain");
        const signer = await requireSigner(
          transfer.recovery.walletAddress,
          transfer.destination.chainId,
        );
        const completed = await submitAndVerifyDestinationMint({
          client: destinationClient,
          transfer,
          submit: async () => {
            await destinationClient.simulateContract({
              account: transfer.recovery.walletAddress,
              address: transfer.destination.messageTransmitterV2,
              abi: CCTP_MESSAGE_TRANSMITTER_V2_ABI,
              functionName: "receiveMessage",
              args: [transfer.message, transfer.attestation],
            });
            setStage("awaiting_mint_signature");
            return signer.writeContract({
              account: transfer.recovery.walletAddress,
              chain: CHAIN_BY_ID[transfer.destination.chainId],
              address: transfer.destination.messageTransmitterV2,
              abi: CCTP_MESSAGE_TRANSMITTER_V2_ABI,
              functionName: "receiveMessage",
              args: [transfer.message, transfer.attestation],
            });
          },
          onPersisted: (nextRecovery, hash) => {
            setRecovery(nextRecovery);
            setDestinationHash(hash);
            setStage("confirming_destination_mint");
          },
        });
        setStage("verifying_completion");
        setDestinationHash(completed.destinationTransactionHash);
        setRecovery(completed.recovery);
        setNonceUsed(completed.nonceState);
        setStage("completed");
        setSuccessOpen(true);
      });
    } catch (cause) {
      if (isWalletRejection(cause) || isRetryableProviderError(cause)) {
        setStage("attestation_ready");
        setProgressCondition({
          tone: "retryable",
          message: isWalletRejection(cause)
            ? "Destination signature was not approved. The confirmed burn remains recoverable and no destination transaction was submitted."
            : `${getFriendlyErrorMessage(cause)} The confirmed burn remains recoverable.`,
        });
      } else {
        setStage("failed");
        setProgressCondition({
          tone: "failed",
          message: getFriendlyErrorMessage(cause),
        });
      }
    }
  }

  function handleStartAnother() {
    clearDirectBridgeRecovery();
    setRecovery(null);
    setTransfer(null);
    setNonceUsed(null);
    setDestinationHash(null);
    setPendingSourceHash(null);
    setSourceSubmittedAt(null);
    setError(null);
    setProgressCondition(null);
    setStage("idle");
    setSuccessOpen(false);
  }

  function handleSourceChange(value: string) {
    const next = value as BridgeTestnetCode;
    const nextDestination = next === ARC_CODE ? "BASE-SEPOLIA" : ARC_CODE;
    assertBridgeRoute(next, nextDestination);
    setSourceCode(next);
    setDestinationCode(nextDestination);
    setMaxFee(null);
    setFeeStatus("idle");
    setFeeError(null);
    setBalance(null);
    setError(null);
  }

  const sourceHash = recovery?.sourceTransactionHash ?? pendingSourceHash;
  const sourceLink = sourceHash
    ? buildExplorerTransactionUrl(
        transfer?.source.code ?? sourceCode,
        sourceHash,
      )
    : null;
  const destinationLink =
    destinationHash && transfer
      ? buildExplorerTransactionUrl(transfer.destination.code, destinationHash)
      : null;
  const insufficient =
    amountUnits !== null && balance !== null && amountUnits > balance;
  const startDisabled =
    busy ||
    amountLocked ||
    !amountUnits ||
    maxFee === null ||
    feeStatus !== "ready" ||
    balance === null ||
    insufficient;
  const progressStage = [
    "confirming_source_burn",
    "waiting_for_attestation",
    "attestation_ready",
    "switching_destination_chain",
    "awaiting_mint_signature",
    "confirming_destination_mint",
    "verifying_completion",
    "failed",
  ].includes(stage)
    ? ((stage === "failed"
        ? recovery?.destinationTransactionHash
          ? "confirming_destination_mint"
          : transfer
            ? "attestation_ready"
            : "waiting_for_attestation"
        : stage) as BridgeProgressStage)
    : null;
  const progressAmount = transfer
    ? formatUnits(transfer.decoded.amount, transfer.source.usdcDecimals)
    : recovery?.amountUnits
      ? formatUnits(BigInt(recovery.amountUnits), source?.usdcDecimals ?? 6)
      : pendingSourceHash
        ? amount
        : null;
  const manualCheckAvailableInSeconds = Math.max(
    0,
    Math.ceil((nextManualCheckAt - manualCheckClock) / 1_000),
  );
  const needsDestinationWallet =
    transfer &&
    nonceUsed === ZERO_NONCE &&
    !recovery?.destinationTransactionHash;
  const showFeeSkeleton = useDelayedLoading(
    feeStatus !== "ready" && feeStatus !== "error" && stage === "idle",
  );

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5 text-primary" />
              Browser-direct CCTP V2 Bridge
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">
                  Source testnet
                </label>
                <Select
                  value={sourceCode}
                  disabled={amountLocked}
                  onValueChange={handleSourceChange}
                >
                  <SelectTrigger aria-label="Bridge source testnet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BRIDGE_TESTNETS.map((network) => (
                      <SelectItem key={network.code} value={network.code}>
                        {network.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">
                  Destination testnet
                </label>
                <Select
                  value={destinationCode}
                  disabled={amountLocked}
                  onValueChange={(value) => {
                    assertBridgeRoute(sourceCode, value);
                    setDestinationCode(value as BridgeTestnetCode);
                    setMaxFee(null);
                    setFeeStatus("idle");
                    setFeeError(null);
                    setError(null);
                  }}
                >
                  <SelectTrigger aria-label="Bridge destination testnet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {destinationOptions.map((network) => (
                      <SelectItem key={network.code} value={network.code}>
                        {network.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                Native test USDC amount
              </label>
              <Input
                aria-label="Bridge amount"
                inputMode="decimal"
                value={amount}
                disabled={amountLocked}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setMaxFee(null);
                  setFeeStatus("idle");
                  setFeeError(null);
                  setError(null);
                }}
              />
              {parsedAmount.error ? (
                <p className="mt-2 text-sm text-destructive">
                  {parsedAmount.error}
                </p>
              ) : insufficient ? (
                <p className="mt-2 text-sm text-destructive">
                  Insufficient source USDC balance.
                </p>
              ) : null}
            </div>
            {progressStage && sourceHash && sourceLink ? (
              <ExternalBridgeProgress
                stage={progressStage}
                sourceNetwork={transfer?.source.name ?? source?.name ?? sourceCode}
                destinationNetwork={
                  transfer?.destination.name ??
                  destination?.name ??
                  destinationCode
                }
                amount={progressAmount}
                token="USDC"
                sourceTransactionHash={sourceHash}
                sourceTransactionUrl={sourceLink}
                createdAt={
                  recovery?.createdAt ??
                  sourceSubmittedAt ??
                  new Date().toISOString()
                }
                condition={progressCondition}
                canCheckStatus={
                  Boolean(recovery) &&
                  progressCondition?.tone !== "failed" &&
                  stage !== "confirming_source_burn"
                }
                checkingStatus={checkingStatus}
                manualCheckAvailableInSeconds={
                  manualCheckAvailableInSeconds
                }
                onCheckStatus={handleManualStatusCheck}
                action={
                  needsDestinationWallet ? (
                    <Button
                      className="h-11 w-full"
                      disabled={
                        busy ||
                        !connectedAddress ||
                        !isAddressEqual(
                          connectedAddress,
                          transfer.recovery.walletAddress,
                        )
                      }
                      onClick={() => void handleMint()}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {!connectedAddress
                        ? "Connect wallet to continue"
                        : !isAddressEqual(
                              connectedAddress,
                              transfer.recovery.walletAddress,
                            )
                          ? "Connect transfer wallet to continue"
                          : busy
                            ? stage.replaceAll("_", " ")
                            : `Complete mint on ${transfer.destination.name}`}
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
            <div className="rounded-xl border border-border/30 bg-background/20 p-4 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Lifecycle</span>
                <span>{stage.replaceAll("_", " ")}</span>
              </div>
              <div className="mt-2 flex justify-between gap-4">
                <span className="text-muted-foreground">Protocol fee cap</span>
                {showFeeSkeleton ? <Skeleton className="h-4 w-24" /> : <span>
                  {maxFee === null
                    ? feeStatus === "error"
                      ? "Unavailable"
                      : "Verifying…"
                    : `${formatUnits(maxFee, source?.usdcDecimals ?? 6)} USDC`}
                </span>}
              </div>
              {transfer ? (
                <>
                  <div className="mt-2 flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      Immutable burned amount
                    </span>
                    <span>
                      {formatUnits(
                        transfer.decoded.amount,
                        transfer.source.usdcDecimals,
                      )}{" "}
                      USDC
                    </span>
                  </div>
                  <div className="mt-2 flex justify-between gap-4">
                    <span className="text-muted-foreground">
                      Destination nonce
                    </span>
                    <span>
                      {nonceUsed === ZERO_NONCE
                        ? "Unused"
                        : nonceUsed === null
                          ? "Checking"
                          : "Used"}
                    </span>
                  </div>
                </>
              ) : null}
            </div>
            {destinationLink ? (
              <a
                className="inline-flex items-center gap-1 text-sm text-primary"
                href={destinationLink}
                target="_blank"
                rel="noreferrer"
              >
                Destination mint <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
            {error ? (
              <div
                role="alert"
                className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}
            {feeError ? (
              <div
                role="alert"
                className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-200"
              >
                <p>{feeError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFeeRetry((value) => value + 1)}
                >
                  Retry fee verification
                </Button>
              </div>
            ) : null}
            {!recovery && !transfer && !pendingSourceHash ? (
              <Button
                className="h-12 w-full"
                disabled={startDisabled}
                onClick={() => void handleStart()}
              >
                <ShieldCheck className="mr-2 h-4 w-4" />
                {busy
                  ? stage.replaceAll("_", " ")
                  : stage === "completed"
                    ? "Bridge complete"
                    : "Authorize source transfer"}
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card className="glass-card border-border/40">
          <CardHeader>
            <CardTitle className="text-base">
              Recover existing transfer
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Recovery reads the confirmed source transaction, Circle Iris, and
              destination nonce directly. The NestJS backend is not required.
            </p>
            <Select
              value={recoverySourceCode}
              onValueChange={(value) =>
                setRecoverySourceCode(value as BridgeTestnetCode)
              }
            >
              <SelectTrigger aria-label="Recovery source testnet">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BRIDGE_TESTNETS.map((network) => (
                  <SelectItem key={network.code} value={network.code}>
                    {network.name} · domain {network.cctpDomain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Source burn transaction hash"
              value={recoveryHash}
              onChange={(event) => setRecoveryHash(event.target.value.trim())}
              placeholder="0x…"
            />
            <Button
              variant="outline"
              className="w-full"
              disabled={busy || !recoveryHash}
              onClick={() => void handleRecover()}
            >
              Recover existing transfer
            </Button>
            <p className="text-xs text-muted-foreground">
              A confirmed burn is never repeated. Wallet access is requested
              only when a new approval, burn, or destination mint signature is
              required.
            </p>
          </CardContent>
        </Card>
      </div>
      {transfer && sourceLink && destinationLink ? (
        <BridgeSuccessDialog
          open={successOpen && stage === "completed"}
          sourceNetwork={transfer.source.name}
          destinationNetwork={transfer.destination.name}
          amount={formatUnits(
            transfer.decoded.amount - transfer.decoded.feeExecuted,
            transfer.destination.usdcDecimals,
          )}
          token="USDC"
          recipient={transfer.decoded.mintRecipient}
          sourceTransactionUrl={sourceLink}
          destinationTransactionUrl={destinationLink}
          onDone={() => setSuccessOpen(false)}
          onStartAnother={handleStartAnother}
        />
      ) : null}
    </>
  );
}
