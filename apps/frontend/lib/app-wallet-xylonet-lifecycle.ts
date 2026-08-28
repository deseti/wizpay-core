import {
  createAppWalletXylonetApprovalChallenge,
  createAppWalletXylonetSwapChallenge,
  pollAppWalletXylonetOperation,
  recordAppWalletXylonetChallengeResult,
  type AppWalletXylonetOperationResponse,
} from "@/lib/app-wallet-swap-service";
import { getFriendlyErrorMessage } from "@/lib/wizpay";

type XylonetStage = "approval" | "swap";
type XylonetRequestStatus =
  | "approving"
  | "confirming"
  | "executing"
  | "settling"
  | "signing"
  | "idle";

interface XylonetLifecycleApi {
  createApprovalChallenge: typeof createAppWalletXylonetApprovalChallenge;
  createSwapChallenge: typeof createAppWalletXylonetSwapChallenge;
  poll: typeof pollAppWalletXylonetOperation;
  recordChallengeResult: typeof recordAppWalletXylonetChallengeResult;
}

const DEFAULT_API: XylonetLifecycleApi = {
  createApprovalChallenge: createAppWalletXylonetApprovalChallenge,
  createSwapChallenge: createAppWalletXylonetSwapChallenge,
  poll: pollAppWalletXylonetOperation,
  recordChallengeResult: recordAppWalletXylonetChallengeResult,
};

const TERMINAL_CHALLENGE_STATUSES = new Set([
  "COMPLETE",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

function readValidatedChallengeStatus(result: unknown) {
  const status =
    typeof result === "object" &&
    result !== null &&
    typeof (result as Record<string, unknown>).status === "string"
      ? ((result as Record<string, unknown>).status as string).toUpperCase()
      : null;

  if (status && TERMINAL_CHALLENGE_STATUSES.has(status)) {
    return status as
      | "COMPLETE"
      | "FAILED"
      | "CANCELLED"
      | "REJECTED"
      | "EXPIRED";
  }

  throw new Error(
    "Circle challenge callback did not return a validated terminal status.",
  );
}

function classifyChallengeError(error: unknown) {
  const message = getFriendlyErrorMessage(error);
  const normalized = message.toLowerCase();
  const status = normalized.includes("cancel")
    ? "CANCELLED"
    : normalized.includes("reject") || normalized.includes("denied")
      ? "REJECTED"
      : normalized.includes("expir")
        ? "EXPIRED"
        : normalized.includes("timeout") || normalized.includes("timed out")
          ? "TIMED_OUT"
          : "FAILED";
  return { status, reason: message } as const;
}

function isProviderOrUnknownChallengeError(error: unknown) {
  const message = getFriendlyErrorMessage(error).toLowerCase();
  return /failed to fetch|network|temporarily unavailable|service unavailable|timeout|timed out/.test(message);
}

export interface RunAppWalletXylonetLifecycleOptions {
  initialOperation: AppWalletXylonetOperationResponse;
  userToken: string;
  executeChallenge: (challengeId: string) => Promise<unknown>;
  onOperation?: (operation: AppWalletXylonetOperationResponse) => void;
  onRequestStatus?: (status: XylonetRequestStatus) => void;
  onChallengeVisibilityChange?: (visible: boolean) => void;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  api?: XylonetLifecycleApi;
}

export async function runAppWalletXylonetLifecycle({
  initialOperation,
  userToken,
  executeChallenge,
  onOperation = () => undefined,
  onRequestStatus = () => undefined,
  onChallengeVisibilityChange = () => undefined,
  pollIntervalMs = 3_000,
  maxPollAttempts = 61,
  api = DEFAULT_API,
}: RunAppWalletXylonetLifecycleOptions) {
  if (!userToken) {
    throw new Error("Circle User-Controlled session is unavailable.");
  }

  const persist = (operation: AppWalletXylonetOperationResponse) => {
    onOperation(operation);
    return operation;
  };

  const pollUntil = async (
    initial: AppWalletXylonetOperationResponse,
    target: "approval_confirmed" | "completed",
  ) => {
    let current = initial;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const next = persist(await api.poll(current.operationId, userToken));
      if (next.lifecycleStage === target || next.terminalStatus) return next;
      current = next;
      if (pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
    throw new Error(
      "Transaction polling timed out before a terminal backend state was returned.",
    );
  };

  const executeStage = async (
    current: AppWalletXylonetOperationResponse,
    stage: XylonetStage,
  ) => {
    const challengeId =
      stage === "approval"
        ? current.approvalChallengeId
        : current.swapChallengeId;
    if (!challengeId) throw new Error(`${stage} challenge ID is missing.`);

    onRequestStatus("signing");
    onChallengeVisibilityChange(false);
    try {
      const status = readValidatedChallengeStatus(
        await executeChallenge(challengeId),
      );
      return persist(
        await api.recordChallengeResult(
          current.operationId,
          stage,
          { status },
          userToken,
        ),
      );
    } catch (error) {
      if (isProviderOrUnknownChallengeError(error)) {
        throw error;
      }
      const failed = await api
        .recordChallengeResult(
          current.operationId,
          stage,
          classifyChallengeError(error),
          userToken,
        )
        .catch(() => null);
      if (failed) persist(failed);
      throw error;
    } finally {
      onChallengeVisibilityChange(true);
    }
  };

  try {
    let current = persist(initialOperation);
    if (
      current.lifecycleStage === "created" ||
      current.lifecycleStage === "approval_challenge_creating"
    ) {
      onRequestStatus("approving");
      current = persist(
        await api.createApprovalChallenge(current.operationId, userToken),
      );
    }
    if (current.lifecycleStage === "awaiting_approval_confirmation") {
      current = await executeStage(current, "approval");
    }
    if (current.lifecycleStage === "approval_submitted") {
      onRequestStatus("confirming");
      current = await pollUntil(current, "approval_confirmed");
    }
    if (
      current.terminalStatus &&
      !(
        current.terminalStatus === "confirmed" &&
        !current.verifiedActualOutput
      )
    ) {
      return current;
    }
    if (
      current.lifecycleStage === "completed" &&
      current.terminalStatus === "confirmed" &&
      !current.verifiedActualOutput
    ) {
      onRequestStatus("settling");
      current = await pollUntil(current, "completed");
    }
    if (
      current.lifecycleStage === "approval_confirmed" ||
      current.lifecycleStage === "swap_challenge_creating"
    ) {
      onRequestStatus("executing");
      current = persist(
        await api.createSwapChallenge(current.operationId, userToken),
      );
    }
    if (current.lifecycleStage === "awaiting_swap_confirmation") {
      current = await executeStage(current, "swap");
    }
    if (current.lifecycleStage === "swap_submitted") {
      onRequestStatus("settling");
      current = await pollUntil(current, "completed");
    }
    if (
      current.lifecycleStage === "completed" &&
      current.terminalStatus === "confirmed" &&
      !current.verifiedActualOutput
    ) {
      current = persist(await api.poll(current.operationId, userToken));
    }

    return current;
  } finally {
    onRequestStatus("idle");
  }
}
