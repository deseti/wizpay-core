import { ArcTestnet } from "@circle-fin/app-kit/chains";
import { ViemAdapter } from "@circle-fin/adapter-viem-v2";
import {
  SwapChain,
  SwapKit,
  type SwapEstimate,
  type SwapResult,
} from "@circle-fin/swap-kit";
import type { Address, Hex, PublicClient, WalletClient } from "viem";

import type { UserSwapPrepareResponse } from "@/lib/user-swap-service";

export type CircleSwapToken = "USDC" | "EURC";

export const USER_SWAP_USDC_ADDRESS =
  "0x3600000000000000000000000000000000000000" as const;
export const USER_SWAP_EURC_ADDRESS =
  "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;

type ArcSwapAdapter = NonNullable<ReturnType<typeof createArcSwapAdapter>>;

type AdapterContext = {
  chain: typeof ArcTestnet;
};

type PreparedAction = {
  type?: string;
  estimate?: () => Promise<{ gas?: bigint | number | string }>;
  execute: (overrides?: { gasLimit?: number }) => Promise<string>;
};

type AdapterWithActions = {
  prepareAction: (
    action: string,
    params: unknown,
    context: AdapterContext,
  ) => Promise<PreparedAction>;
  waitForTransaction?: (
    txHash: string,
    options: unknown,
    chain: typeof ArcTestnet,
  ) => Promise<unknown>;
};

type CircleSwapInstruction = {
  target: Hex;
  data: Hex;
  value: bigint;
  tokenIn: Address;
  amountToApprove: bigint;
  tokenOut: Address;
  minTokenOut: bigint;
};

type CircleSwapExecuteParams = {
  instructions: CircleSwapInstruction[];
  tokens: Array<{
    token: Address;
    beneficiary: Address;
  }>;
  execId: bigint;
  deadline: bigint;
  metadata: Hex;
};

export const CIRCLE_SWAP_TOKENS: Array<{
  symbol: CircleSwapToken;
  label: string;
}> = [
  { symbol: "USDC", label: "USDC - USD Coin" },
  { symbol: "EURC", label: "EURC - Euro Coin" },
];

const swapKit = new SwapKit();

export function getCircleKitKey(): string {
  return process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY ?? "";
}

export function createArcSwapAdapter(
  publicClient: PublicClient | undefined,
  walletClient: WalletClient | undefined
) {
  if (!publicClient || !walletClient) {
    return null;
  }

  return new ViemAdapter(
    {
      getPublicClient: () => publicClient,
      getWalletClient: async () => walletClient,
    },
    {
      addressContext: "user-controlled",
      supportedChains: [ArcTestnet],
    }
  );
}

function buildSwapParams(params: {
  adapter: ReturnType<typeof createArcSwapAdapter>;
  tokenIn: CircleSwapToken;
  tokenOut: CircleSwapToken;
  amountIn: string;
  slippageBps: number;
  kitKey: string;
}) {
  const { adapter, tokenIn, tokenOut, amountIn, slippageBps, kitKey } = params;

  if (!adapter) {
    throw new Error("Swap adapter is not ready. Connect your Arc wallet first.");
  }

  return {
    from: {
      adapter,
      chain: SwapChain.Arc_Testnet,
    },
    tokenIn,
    tokenOut,
    amountIn,
    config: {
      allowanceStrategy: "permit" as const,
      kitKey,
      slippageBps,
    },
  };
}

export async function estimateArcSwap(params: {
  adapter: ReturnType<typeof createArcSwapAdapter>;
  tokenIn: CircleSwapToken;
  tokenOut: CircleSwapToken;
  amountIn: string;
  slippageBps: number;
  kitKey: string;
}): Promise<SwapEstimate> {
  return swapKit.estimate(buildSwapParams(params) as any);
}

export async function executeArcSwap(params: {
  adapter: ReturnType<typeof createArcSwapAdapter>;
  tokenIn: CircleSwapToken;
  tokenOut: CircleSwapToken;
  amountIn: string;
  slippageBps: number;
  kitKey: string;
}): Promise<SwapResult> {
  return swapKit.swap(buildSwapParams(params) as any);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRawTransaction(prepared: UserSwapPrepareResponse) {
  if (isRecord(prepared.raw) && isRecord(prepared.raw.transaction)) {
    return prepared.raw.transaction;
  }

  return prepared.transaction;
}

function normalizeAddress(value: unknown, fieldName: string): Address {
  if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)) {
    return value as Address;
  }

  throw new Error(`Circle swap response is missing a valid ${fieldName}.`);
}

function normalizeHex(value: unknown, fieldName: string): Hex {
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)) {
    return value as Hex;
  }

  throw new Error(`Circle swap response is missing a valid ${fieldName}.`);
}

function normalizeBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(value);
  }

  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`Circle swap response has an invalid ${fieldName}.`);
    }
  }

  throw new Error(`Circle swap response is missing ${fieldName}.`);
}

function optionalGasLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed =
    typeof value === "number" ? value : Number(normalizeBigInt(value, "gasLimit"));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getTokenInAddress(
  prepared: UserSwapPrepareResponse,
  tokenIn: CircleSwapToken,
): Address {
  if (isRecord(prepared.raw) && prepared.raw.tokenInAddress !== undefined) {
    return normalizeAddress(prepared.raw.tokenInAddress, "tokenInAddress");
  }

  return tokenIn === "USDC" ? USER_SWAP_USDC_ADDRESS : USER_SWAP_EURC_ADDRESS;
}

function getPreparedAmount(prepared: UserSwapPrepareResponse): bigint {
  if (isRecord(prepared.raw) && prepared.raw.amount !== undefined) {
    return normalizeBigInt(prepared.raw.amount, "amount");
  }

  return normalizeBigInt(prepared.amountIn, "amountIn");
}

function buildExecuteParams(transaction: Record<string, unknown>) {
  const executionParams = transaction.executionParams;

  if (!isRecord(executionParams)) {
    throw new Error(
      "Circle swap response did not include execution parameters for the wallet adapter.",
    );
  }

  if (!Array.isArray(executionParams.instructions)) {
    throw new Error("Circle swap response did not include execution instructions.");
  }

  const instructions: CircleSwapInstruction[] =
    executionParams.instructions.map((instruction, index) => {
      if (!isRecord(instruction)) {
        throw new Error(`Circle swap instruction ${index + 1} is invalid.`);
      }

      return {
        target: normalizeAddress(instruction.target, "instruction.target"),
        data: normalizeHex(instruction.data, "instruction.data"),
        value: normalizeBigInt(instruction.value, "instruction.value"),
        tokenIn: normalizeAddress(instruction.tokenIn, "instruction.tokenIn"),
        amountToApprove: normalizeBigInt(
          instruction.amountToApprove,
          "instruction.amountToApprove",
        ),
        tokenOut: normalizeAddress(instruction.tokenOut, "instruction.tokenOut"),
        minTokenOut: normalizeBigInt(
          instruction.minTokenOut,
          "instruction.minTokenOut",
        ),
      };
    });

  const tokens = Array.isArray(executionParams.tokens)
    ? executionParams.tokens.map((token, index) => {
        if (!isRecord(token)) {
          throw new Error(`Circle swap token output ${index + 1} is invalid.`);
        }

        return {
          token: normalizeAddress(token.token, "token.token"),
          beneficiary: normalizeAddress(token.beneficiary, "token.beneficiary"),
        };
      })
    : [];

  return {
    instructions,
    tokens,
    execId: normalizeBigInt(executionParams.execId, "execId"),
    deadline: normalizeBigInt(executionParams.deadline, "deadline"),
    metadata: normalizeHex(executionParams.metadata, "metadata"),
  } satisfies CircleSwapExecuteParams;
}

function buildTokenInputs(tokenInAddress: Address, inputAmount: bigint) {
  return [
    {
      permitType: 0,
      token: tokenInAddress,
      amount: inputAmount,
      permitCalldata: "0x" as const,
    },
  ];
}

async function approveSwapInput(params: {
  adapter: AdapterWithActions;
  context: AdapterContext;
  tokenInAddress: Address;
  inputAmount: bigint;
}) {
  const adapterContract = ArcTestnet.kitContracts?.adapter;

  if (!adapterContract) {
    throw new Error(
      "Circle Arc Testnet adapter contract is not configured for token approval.",
    );
  }

  const approval = await params.adapter.prepareAction(
    "token.approve",
    {
      tokenAddress: params.tokenInAddress,
      delegate: adapterContract,
      amount: params.inputAmount,
    },
    params.context,
  );
  const approvalTxHash = await approval.execute();

  if (params.adapter.waitForTransaction) {
    await params.adapter.waitForTransaction(approvalTxHash, undefined, ArcTestnet);
  }
}

async function executePreparedAction(
  preparedAction: PreparedAction,
  gasLimit?: number,
) {
  if (preparedAction.type === "evm" && gasLimit) {
    let effectiveGasLimit = gasLimit;

    try {
      const localEstimate = await preparedAction.estimate?.();
      const localGas = Number(localEstimate?.gas);

      if (Number.isFinite(localGas) && localGas > 0) {
        effectiveGasLimit = Math.max(Math.ceil(localGas * 1.3), gasLimit);
      }
    } catch {
      // Use the Circle-provided gas limit if local estimation is unavailable.
    }

    return preparedAction.execute({ gasLimit: effectiveGasLimit });
  }

  return preparedAction.execute();
}

export async function executePreparedArcUserSwap(params: {
  adapter: ArcSwapAdapter;
  prepared: UserSwapPrepareResponse;
  tokenIn: CircleSwapToken;
}) {
  const adapter = params.adapter as unknown as AdapterWithActions;
  const context: AdapterContext = { chain: ArcTestnet };
  const transaction = getRawTransaction(params.prepared);

  if (!isRecord(transaction)) {
    throw new Error("Circle swap response did not include a transaction payload.");
  }

  const signature = normalizeHex(transaction.signature, "transaction.signature");
  const executeParams = buildExecuteParams(transaction);
  const tokenInAddress = getTokenInAddress(params.prepared, params.tokenIn);
  const inputAmount = getPreparedAmount(params.prepared);
  const gasLimit = optionalGasLimit(transaction.gasLimit);

  await approveSwapInput({
    adapter,
    context,
    tokenInAddress,
    inputAmount,
  });

  const preparedAction = await adapter.prepareAction(
    "swap.execute",
    {
      executeParams,
      tokenInputs: buildTokenInputs(tokenInAddress, inputAmount),
      signature,
      inputAmount,
      tokenInAddress,
    },
    context,
  );

  return executePreparedAction(preparedAction, gasLimit);
}
