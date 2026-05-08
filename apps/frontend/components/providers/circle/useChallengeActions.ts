"use client";

import { useCallback } from "react";
import type React from "react";
import type { Address, Hex } from "viem";
import {
  getPasskeyTokenBalances,
  type PasskeyChainRuntime,
} from "@/lib/circle-passkey";
import {
  isCircleRecoverableSessionError,
  isPasskeySession,
  isRecord,
  isHexValue,
  createLocalChallengeId,
  extractChallengeId,
  normalizeCircleWalletTokenBalance,
  type CircleSession,
  type CirclePasskeyChallenge,
  type CircleWalletTokenBalance,
} from "@/services/circle-auth.service";

// Normalizes W3S action payload fields before sending to backend.
function buildW3sUserActionParams(
  payload: Record<string, unknown>,
  userToken: string,
) {
  const normalized: Record<string, unknown> = {
    ...payload,
    userToken,
  };

  if (typeof normalized.walletId === "string") {
    normalized.walletId = normalized.walletId.trim();
  }

  if (typeof normalized.contractAddress === "string") {
    normalized.contractAddress = normalized.contractAddress
      .trim()
      .toLowerCase();
  }

  if (typeof normalized.destinationAddress === "string") {
    const destAddr = normalized.destinationAddress.trim();
    normalized.destinationAddress = destAddr.startsWith("0x")
      ? destAddr.toLowerCase()
      : destAddr;
  }

  if (Array.isArray(normalized.amounts)) {
    normalized.amounts = normalized.amounts.map((amount) => String(amount));
  }

  if (typeof normalized.amount === "number") {
    normalized.amount = String(normalized.amount);
  }

  if (typeof normalized.blockchain === "string") {
    normalized.blockchain = normalized.blockchain
      .trim()
      .toUpperCase()
      .replace(/_/g, "-");
  }

  if (typeof normalized.sourceChain === "string") {
    normalized.sourceChain = normalized.sourceChain
      .trim()
      .toUpperCase()
      .replace(/_/g, "-");
  }

  if (typeof normalized.destinationChain === "string") {
    normalized.destinationChain = normalized.destinationChain
      .trim()
      .toUpperCase()
      .replace(/_/g, "-");
  }

  return normalized;
}

export interface ChallengeActionsDeps {
  session: CircleSession | null;
  ensureCircleSessionReady: (options?: {
    forceReinitialize?: boolean;
    reason?: string;
    refreshWallets?: boolean;
  }) => Promise<void>;
  postW3sAction: (
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  executeChallengeForSession: (
    challengeId: string,
    authSession: CircleSession,
  ) => Promise<unknown>;
  passkeyChallengeStoreRef: React.MutableRefObject<
    Map<string, CirclePasskeyChallenge>
  >;
  passkeyRuntimeByWalletIdRef: React.MutableRefObject<
    Map<string, PasskeyChainRuntime>
  >;
}

export function useChallengeActions({
  session,
  ensureCircleSessionReady,
  postW3sAction,
  executeChallengeForSession,
  passkeyChallengeStoreRef,
  passkeyRuntimeByWalletIdRef,
}: ChallengeActionsDeps) {
  const withRecoveredSession = useCallback(
    async <T,>(
      actionLabel: string,
      action: () => Promise<T>,
      options?: { refreshWallets?: boolean },
    ) => {
      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      await ensureCircleSessionReady({
        reason: `${actionLabel}:preflight`,
        refreshWallets: options?.refreshWallets,
      });

      try {
        return await action();
      } catch (error) {
        if (!isCircleRecoverableSessionError(error)) {
          throw error;
        }

        await ensureCircleSessionReady({
          forceReinitialize: true,
          reason: `${actionLabel}:retry`,
          refreshWallets: true,
        });

        return action();
      }
    },
    [ensureCircleSessionReady, session],
  );

  const executeChallenge = useCallback(
    async (challengeId: string) => {
      if (!session) {
        throw new Error("Circle session is not available.");
      }

       if (isPasskeySession(session)) {
        return executeChallengeForSession(challengeId, session);
      }

      return withRecoveredSession(
        "executeChallenge",
        () => executeChallengeForSession(challengeId, session),
        { refreshWallets: false },
      );
    },
    [executeChallengeForSession, session, withRecoveredSession],
  );

  const createContractExecutionChallenge = useCallback(
    async (payload: Record<string, unknown>) => {
      if (isPasskeySession(session)) {
        const walletId =
          typeof payload.walletId === "string" && payload.walletId
            ? payload.walletId
            : null;
        const contractAddress = isHexValue(payload.contractAddress, 20)
          ? (payload.contractAddress as Address)
          : null;
        const callData = isHexValue(payload.callData)
          ? (payload.callData as Hex)
          : null;

        if (!walletId || !contractAddress || !callData) {
          throw new Error(
            "Passkey execution payload is missing the target wallet, contract, or calldata.",
          );
        }

        const challengeId = createLocalChallengeId("passkey-contract");

        passkeyChallengeStoreRef.current.set(challengeId, {
          callData,
          contractAddress,
          kind: "contract",
          referenceId:
            typeof payload.refId === "string" && payload.refId
              ? payload.refId
              : null,
          walletId,
        });

        return {
          challengeId,
          raw: {
            challengeId,
            transactionId:
              typeof payload.refId === "string" && payload.refId
                ? payload.refId
                : null,
            walletId,
          },
        };
      }

      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await withRecoveredSession(
        "createContractExecutionChallenge",
        () =>
          postW3sAction(
            "createContractExecutionChallenge",
            buildW3sUserActionParams(payload, session.userToken),
          ),
      );

      if (!isRecord(response)) {
        throw new Error("Circle did not return a valid challenge response.");
      }

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a challenge identifier.");
      }

      return {
        challengeId,
        raw: response,
      };
    },
    [passkeyChallengeStoreRef, postW3sAction, session, withRecoveredSession],
  );

  const createTransferChallenge = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await withRecoveredSession(
        "createTransferChallenge",
        () =>
          postW3sAction(
            "createTransferChallenge",
            buildW3sUserActionParams(payload, session.userToken),
          ),
      );

      if (!isRecord(response)) {
        throw new Error("Circle did not return a valid challenge response.");
      }

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a challenge identifier.");
      }

      return {
        challengeId,
        raw: response,
      };
    },
    [postW3sAction, session, withRecoveredSession],
  );

  const createTypedDataChallenge = useCallback(
    async (payload: Record<string, unknown>) => {
      if (isPasskeySession(session)) {
        const walletId =
          typeof payload.walletId === "string" && payload.walletId
            ? payload.walletId
            : null;
        const typedDataJson =
          typeof payload.data === "string" && payload.data
            ? payload.data
            : null;

        if (!walletId || !typedDataJson) {
          throw new Error(
            "Passkey typed-data payload is missing the target wallet or payload.",
          );
        }

        const challengeId = createLocalChallengeId("passkey-typed-data");

        passkeyChallengeStoreRef.current.set(challengeId, {
          kind: "typed-data",
          typedDataJson,
          walletId,
        });

        return {
          challengeId,
          raw: {
            challengeId,
            walletId,
          },
        };
      }

      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await withRecoveredSession(
        "createTypedDataChallenge",
        () =>
          postW3sAction(
            "createTypedDataChallenge",
            buildW3sUserActionParams(payload, session.userToken),
          ),
      );

      if (!isRecord(response)) {
        throw new Error(
          "Circle did not return a valid sign challenge response.",
        );
      }

      const challengeId = extractChallengeId(response);

      if (!challengeId) {
        throw new Error("Circle did not return a sign challenge identifier.");
      }

      return {
        challengeId,
        raw: response,
      };
    },
    [passkeyChallengeStoreRef, postW3sAction, session, withRecoveredSession],
  );

  const getWalletBalances = useCallback(
    async (walletId: string): Promise<CircleWalletTokenBalance[]> => {
      if (isPasskeySession(session)) {
        const runtime = passkeyRuntimeByWalletIdRef.current.get(walletId);

        if (!runtime) {
          throw new Error("Passkey wallet session is not ready.");
        }

        const passkeyBalances = await getPasskeyTokenBalances(runtime);
        return passkeyBalances.map((pb) => ({
          ...pb,
          tokenId: null,
        })) as CircleWalletTokenBalance[];
      }

      if (!session || isPasskeySession(session) || !session.userToken) {
        throw new Error("Circle session is not available.");
      }

      const response = await withRecoveredSession(
        "getWalletBalances",
        () =>
          postW3sAction("getWalletBalances", {
            userToken: session.userToken,
            walletId,
          }),
        { refreshWallets: false },
      );

      if (!isRecord(response) || !Array.isArray(response.tokenBalances)) {
        return [];
      }

      return response.tokenBalances
        .map((balance) => normalizeCircleWalletTokenBalance(balance))
        .filter(
          (balance): balance is CircleWalletTokenBalance => balance !== null,
        );
    },
    [passkeyRuntimeByWalletIdRef, postW3sAction, session, withRecoveredSession],
  );

  return {
    executeChallenge,
    createContractExecutionChallenge,
    createTransferChallenge,
    createTypedDataChallenge,
    getWalletBalances,
  };
}
