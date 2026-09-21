/**
 * @deprecated Transaction execution has been moved to the NestJS backend.
 * Frontend no longer executes transactions directly.
 * Use `useTaskPolling` to submit tasks to `POST /tasks` instead.
 *
 * This file is kept for backward compatibility with non-payroll flows
 * that still need client-side external wallet interaction (e.g. token
 * approvals). External self-custodial wallets only; no fallback execution.
 */
"use client";

import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { usePublicClient, useSwitchChain, useWalletClient } from "wagmi";

import { useExternalWallet } from "@/components/providers/external-wallet-context";
import { writeContractTransaction } from "@/lib/web3-transactions";
import { prepareWalletExecutionIntent } from "@/lib/execution-intent";
import { requestExternalWalletChain } from "@/lib/external-wallet-policy";
import { activeArcChain, CHAIN_BY_ID } from "@/lib/wagmi";

export type ExecuteTransactionParams = {
  abi: Abi;
  args?: readonly unknown[];
  chainId?: number;
  contractAddress: Address;
  functionName: string;
  value?: bigint;
  idempotencyKey?: string;
  executionIntentId?: string;
  onWalletPrepared?: (leaseOwner: string) => void | Promise<void>;
  memo?: string;
  refId: string;
};

export type ExecuteTransactionResult = {
  hash: string;
  referenceId: string;
  startBlock: bigint;
  txHash: Hex | null;
  executionLeaseOwner?: string;
};

type SignTypedDataParams = {
  chainId?: number;
  memo?: string;
  typedData: Record<string, unknown>;
};

export type SignTypedDataResult = {
  chainId: number;
  signature: Hex;
  walletAddress?: Address;
  walletMode: "external";
};

export function useTransactionExecutor() {
  const { activeWalletAddress, activeWalletChainId } = useExternalWallet();
  const arcPublicClient = usePublicClient({ chainId: activeArcChain.id });
  const { data: walletClient, refetch: refetchWalletClient } =
    useWalletClient();
  const { switchChainAsync } = useSwitchChain();

  const getPublicClientForChain = (chainId: number) => {
    if (chainId === activeArcChain.id) {
      return arcPublicClient;
    }

    return null;
  };

  const ensureExternalChain = async (targetChainId: number) => {
    await requestExternalWalletChain({
      currentChainId: activeWalletChainId,
      targetChainId,
      switchChain: switchChainAsync,
    });
  };

  const getExternalWalletClient = async (targetChainId: number) => {
    await ensureExternalChain(targetChainId);

    const refreshed = await refetchWalletClient();
    const nextWalletClient = refreshed.data ?? walletClient;

    if (!nextWalletClient) {
      throw new Error(
        "External wallet client is not ready. Reconnect the wallet and try again.",
      );
    }

    return nextWalletClient;
  };

  const executeWithViem = async (
    params: ExecuteTransactionParams,
  ): Promise<ExecuteTransactionResult> => {
    const chainId = params.chainId ?? activeArcChain.id;
    const chain = CHAIN_BY_ID[chainId];
    const publicClient = getPublicClientForChain(chainId);

    if (!chain || !publicClient) {
      throw new Error(
        `Chain ${chainId} is not configured for external wallet transactions.`,
      );
    }

    if (!activeWalletAddress) {
      throw new Error(
        "Connect an external wallet before sending a transaction.",
      );
    }

    const startBlock = await publicClient.getBlockNumber();
    const nextWalletClient = await getExternalWalletClient(chainId);
    let executionLeaseOwner: string | undefined;
    if (params.executionIntentId) {
      if (!params.idempotencyKey)
        throw new Error("Durable execution intent access key is missing.");
      executionLeaseOwner = crypto.randomUUID();
      await prepareWalletExecutionIntent(
        params.executionIntentId,
        params.idempotencyKey,
        executionLeaseOwner,
      );
      await params.onWalletPrepared?.(executionLeaseOwner);
    }
    const txHash = await writeContractTransaction({
      abi: params.abi,
      account: activeWalletAddress,
      address: params.contractAddress,
      args: params.args,
      chain,
      functionName: params.functionName,
      value: params.value,
      walletClient: nextWalletClient,
    });

    return {
      hash: txHash,
      referenceId: params.refId,
      startBlock,
      txHash,
      ...(executionLeaseOwner ? { executionLeaseOwner } : {}),
    };
  };

  const executeTransaction = async (
    params: ExecuteTransactionParams,
  ): Promise<ExecuteTransactionResult> => {
    return executeWithViem(params);
  };

  const signTypedDataWithMetadata = async ({
    chainId = activeArcChain.id,
    typedData,
  }: SignTypedDataParams): Promise<SignTypedDataResult> => {
    if (!activeWalletAddress) {
      throw new Error("Connect an external wallet before signing typed data.");
    }

    const nextWalletClient = await getExternalWalletClient(chainId);
    const signature = await nextWalletClient.request({
      method: "eth_signTypedData_v4",
      params: [activeWalletAddress, JSON.stringify(typedData)],
    });

    return {
      chainId,
      signature: signature as Hex,
      walletAddress: activeWalletAddress,
      walletMode: "external",
    };
  };

  const signTypedData = async (params: SignTypedDataParams): Promise<Hex> => {
    const result = await signTypedDataWithMetadata(params);
    return result.signature;
  };

  return {
    executeTransaction,
    signTypedData,
    signTypedDataWithMetadata,
  };
}
