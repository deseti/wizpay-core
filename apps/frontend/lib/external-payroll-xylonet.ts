import {
  decodeEventLog,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";

import { WIZPAY_BATCH_PAYMENT_ROUTED_EVENT } from "@/constants/abi";
import { WIZPAY_ADDRESS } from "@/constants/addresses";
import {
  validateExternalXylonetQuote,
  verifyExternalXylonetReceipt,
  type ValidatedExternalXylonetQuote,
} from "@/lib/external-xylonet-swap";
import type { UserSwapQuoteResponse } from "@/lib/user-swap-service";
import type { TokenSymbol } from "@/lib/wizpay";

const STORAGE_PREFIX = "wizpay:external-payroll-xylonet:v1";

export interface ExternalPayrollXylonetBinding {
  referenceId: string;
  walletAddress: Address;
  chainId: number;
  tokenIn: TokenSymbol;
  tokenOut: TokenSymbol;
  tokenInAddress: Address;
  tokenOutAddress: Address;
  amountIn: string;
  minimumRequiredOutput: string;
  recipients: readonly {
    id: string;
    address: string;
    targetToken: TokenSymbol;
    sourceAmount: string;
  }[];
}

interface PersistedQuote {
  executor: Address;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  minimumAmountOut: string;
  recipient: Address;
  deadline: string;
}

interface PersistedBatchConfirmation {
  referenceId: string;
  txHash: Hex;
}

interface PersistedExternalPayrollXylonetState {
  version: 1;
  binding: ExternalPayrollXylonetBinding;
  stage:
    | "swap_ready"
    | "swap_submitted"
    | "swap_confirmed"
    | "payroll_in_progress";
  quote: PersistedQuote;
  approvalTxHash: Hex | null;
  swapTxHash: Hex | null;
  verifiedActualOutput: string | null;
  completedBatches: PersistedBatchConfirmation[];
  pendingBatchReferenceId: string | null;
  updatedAt: string;
}

interface ConfirmedReceipt {
  status: string;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}

export interface ExternalPayrollXylonetActions {
  assertWallet: () => void;
  readAllowance: (token: Address, owner: Address, spender: Address) => Promise<bigint>;
  submitApproval: (token: Address, spender: Address, amount: bigint) => Promise<Hex>;
  submitSwap: (quote: ValidatedExternalXylonetQuote) => Promise<Hex>;
  waitForReceipt: (hash: Hex) => Promise<ConfirmedReceipt>;
}

export interface ExternalPayrollXylonetResult {
  txHash: Hex;
  verifiedActualOutput: string;
  resumed: boolean;
}

function normalizeBinding(
  binding: ExternalPayrollXylonetBinding,
): ExternalPayrollXylonetBinding {
  return {
    ...binding,
    referenceId: binding.referenceId.trim(),
    walletAddress: getAddress(binding.walletAddress),
    tokenInAddress: getAddress(binding.tokenInAddress),
    tokenOutAddress: getAddress(binding.tokenOutAddress),
    recipients: binding.recipients.map((recipient) => ({
      ...recipient,
      address: isAddress(recipient.address)
        ? getAddress(recipient.address)
        : recipient.address.trim().toLowerCase(),
    })),
  };
}

function bindingKey(binding: ExternalPayrollXylonetBinding) {
  const normalized = normalizeBinding(binding);
  return [
    STORAGE_PREFIX,
    normalized.chainId,
    normalized.walletAddress.toLowerCase(),
    encodeURIComponent(normalized.referenceId),
    normalized.tokenIn,
    normalized.tokenOut,
  ].join(":");
}

function sameBinding(
  left: ExternalPayrollXylonetBinding,
  right: ExternalPayrollXylonetBinding,
) {
  const withoutPreviewMinimum = (binding: ExternalPayrollXylonetBinding) => {
    const normalized = normalizeBinding(binding);
    return {
      referenceId: normalized.referenceId,
      walletAddress: normalized.walletAddress,
      chainId: normalized.chainId,
      tokenIn: normalized.tokenIn,
      tokenOut: normalized.tokenOut,
      tokenInAddress: normalized.tokenInAddress,
      tokenOutAddress: normalized.tokenOutAddress,
      amountIn: normalized.amountIn,
      recipients: normalized.recipients,
    };
  };
  return (
    JSON.stringify(withoutPreviewMinimum(left)) ===
    JSON.stringify(withoutPreviewMinimum(right))
  );
}

function readState(
  storage: Storage,
  binding: ExternalPayrollXylonetBinding,
): PersistedExternalPayrollXylonetState | null {
  const raw = storage.getItem(bindingKey(binding));
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Saved External Wallet payroll recovery state is invalid.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Saved External Wallet payroll recovery state is invalid.");
  }
  const state = parsed as PersistedExternalPayrollXylonetState;
  if (state.version !== 1 || !state.binding || !sameBinding(state.binding, binding)) {
    throw new Error(
      "Saved External Wallet payroll state does not match this wallet, route, amount, or recipient set.",
    );
  }
  return state;
}

function writeState(
  storage: Storage,
  binding: ExternalPayrollXylonetBinding,
  state: PersistedExternalPayrollXylonetState,
) {
  storage.setItem(bindingKey(binding), JSON.stringify(state));
}

function persistQuote(quote: ValidatedExternalXylonetQuote): PersistedQuote {
  return {
    ...quote,
    amountIn: quote.amountIn.toString(),
    minimumAmountOut: quote.minimumAmountOut.toString(),
    deadline: quote.deadline.toString(),
  };
}

function restoreQuote(quote: PersistedQuote): ValidatedExternalXylonetQuote {
  return {
    executor: getAddress(quote.executor),
    router: getAddress(quote.router),
    tokenIn: getAddress(quote.tokenIn),
    tokenOut: getAddress(quote.tokenOut),
    amountIn: BigInt(quote.amountIn),
    minimumAmountOut: BigInt(quote.minimumAmountOut),
    recipient: getAddress(quote.recipient),
    deadline: BigInt(quote.deadline),
  };
}

function assertPersistedQuoteBinding(
  quote: ValidatedExternalXylonetQuote,
  binding: ExternalPayrollXylonetBinding,
) {
  const configuredExecutor =
    process.env.NEXT_PUBLIC_WIZPAY_SWAP_EXECUTOR_V2_ADDRESS;
  if (
    !configuredExecutor ||
    !isAddress(configuredExecutor) ||
    quote.executor.toLowerCase() !== configuredExecutor.toLowerCase() ||
    quote.tokenIn.toLowerCase() !== binding.tokenInAddress.toLowerCase() ||
    quote.tokenOut.toLowerCase() !== binding.tokenOutAddress.toLowerCase() ||
    quote.recipient.toLowerCase() !== binding.walletAddress.toLowerCase() ||
    quote.amountIn !== BigInt(binding.amountIn) ||
    quote.minimumAmountOut <= 0n
  ) {
    throw new Error(
      "Saved XyloNet quote does not match the bound payroll route.",
    );
  }
}

async function confirmPersistedSwap(
  storage: Storage,
  binding: ExternalPayrollXylonetBinding,
  state: PersistedExternalPayrollXylonetState,
  actions: ExternalPayrollXylonetActions,
  resumed: boolean,
): Promise<ExternalPayrollXylonetResult> {
  actions.assertWallet();
  if (!state.swapTxHash) {
    throw new Error(
      "A prior External Wallet swap submission has an unknown outcome. Verify the wallet activity before retrying; WizPay will not submit another swap.",
    );
  }
  const swapTxHash = state.swapTxHash;
  const quote = restoreQuote(state.quote);
  assertPersistedQuoteBinding(quote, binding);
  const receipt = await actions.waitForReceipt(swapTxHash);
  const amountOut = verifyExternalXylonetReceipt({
    receipt,
    expected: { ...quote, walletAddress: binding.walletAddress },
  });
  if (amountOut < BigInt(binding.minimumRequiredOutput)) {
    throw new Error(
      "Confirmed XyloNet output is below the payroll minimum accepted by the user.",
    );
  }
  if (
    state.verifiedActualOutput &&
    state.verifiedActualOutput !== amountOut.toString()
  ) {
    throw new Error("Saved XyloNet output does not match the verified receipt.");
  }

  const confirmed: PersistedExternalPayrollXylonetState = {
    ...state,
    stage:
      state.completedBatches.length > 0
        ? "payroll_in_progress"
        : "swap_confirmed",
    verifiedActualOutput: amountOut.toString(),
    updatedAt: new Date().toISOString(),
  };
  writeState(storage, binding, confirmed);
  return {
    txHash: swapTxHash,
    verifiedActualOutput: amountOut.toString(),
    resumed,
  };
}

export async function runExternalPayrollXylonetSwap(input: {
  binding: ExternalPayrollXylonetBinding;
  storage: Storage;
  quote: () => Promise<UserSwapQuoteResponse>;
  actions: ExternalPayrollXylonetActions;
}): Promise<ExternalPayrollXylonetResult> {
  const binding = normalizeBinding(input.binding);
  const amountIn = BigInt(binding.amountIn);
  const minimumRequiredOutput = BigInt(binding.minimumRequiredOutput);
  if (amountIn <= 0n || minimumRequiredOutput <= 0n) {
    throw new Error("External Wallet payroll swap amounts must be positive.");
  }

  const saved = readState(input.storage, binding);
  if (saved) {
    return confirmPersistedSwap(
      input.storage,
      saved.binding,
      saved,
      input.actions,
      true,
    );
  }

  input.actions.assertWallet();
  const quote = validateExternalXylonetQuote(await input.quote(), {
    walletAddress: binding.walletAddress,
    chainId: binding.chainId,
    tokenIn: binding.tokenIn,
    tokenOut: binding.tokenOut,
    tokenInAddress: binding.tokenInAddress,
    tokenOutAddress: binding.tokenOutAddress,
    amountIn,
  });
  if (quote.minimumAmountOut < minimumRequiredOutput) {
    throw new Error(
      "The fresh XyloNet quote is below the payroll minimum accepted by the user.",
    );
  }

  let approvalTxHash: Hex | null = null;
  const allowance = await input.actions.readAllowance(
    quote.tokenIn,
    binding.walletAddress,
    quote.executor,
  );
  if (allowance < quote.amountIn) {
    input.actions.assertWallet();
    approvalTxHash = await input.actions.submitApproval(
      quote.tokenIn,
      quote.executor,
      quote.amountIn,
    );
    const approvalReceipt = await input.actions.waitForReceipt(approvalTxHash);
    if (approvalReceipt.status !== "success") {
      throw new Error("XyloNet source-token approval transaction reverted.");
    }
    const confirmedAllowance = await input.actions.readAllowance(
      quote.tokenIn,
      binding.walletAddress,
      quote.executor,
    );
    if (confirmedAllowance < quote.amountIn) {
      throw new Error(
        "XyloNet source-token allowance is below the required swap amount after approval.",
      );
    }
  }

  const ready: PersistedExternalPayrollXylonetState = {
    version: 1,
    binding,
    stage: "swap_ready",
    quote: persistQuote(quote),
    approvalTxHash,
    swapTxHash: null,
    verifiedActualOutput: null,
    completedBatches: [],
    pendingBatchReferenceId: null,
    updatedAt: new Date().toISOString(),
  };
  writeState(input.storage, binding, ready);

  input.actions.assertWallet();
  let swapTxHash: Hex;
  try {
    swapTxHash = await input.actions.submitSwap(quote);
  } catch (error) {
    input.storage.removeItem(bindingKey(binding));
    throw error;
  }
  const submitted: PersistedExternalPayrollXylonetState = {
    ...ready,
    stage: "swap_submitted",
    swapTxHash,
    updatedAt: new Date().toISOString(),
  };
  writeState(input.storage, binding, submitted);

  return confirmPersistedSwap(
    input.storage,
    binding,
    submitted,
    input.actions,
    false,
  );
}

function verifyPayrollBatchReceipt(input: {
  binding: ExternalPayrollXylonetBinding;
  referenceId: string;
  receipt: ConfirmedReceipt;
}) {
  if (input.receipt.status !== "success") {
    throw new Error("Payroll transaction did not confirm successfully.");
  }
  for (const log of input.receipt.logs) {
    if (log.address.toLowerCase() !== WIZPAY_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [WIZPAY_BATCH_PAYMENT_ROUTED_EVENT],
        eventName: "BatchPaymentRouted",
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
      });
      if (
        decoded.args.sender.toLowerCase() ===
          input.binding.walletAddress.toLowerCase() &&
        decoded.args.referenceId === input.referenceId
      ) {
        return;
      }
    } catch {
      // Ignore unrelated WizPay logs and continue to the bound payroll event.
    }
  }
  throw new Error("Payroll receipt does not match this wallet and batch reference.");
}

export async function recordExternalPayrollBatchConfirmation(input: {
  binding: ExternalPayrollXylonetBinding;
  storage: Storage;
  referenceId: string;
  txHash: Hex;
  waitForReceipt: (hash: Hex) => Promise<ConfirmedReceipt>;
}) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.txHash)) {
    throw new Error("Payroll confirmation transaction hash is invalid.");
  }
  const state = readState(input.storage, input.binding);
  if (!state || !state.verifiedActualOutput) {
    throw new Error("Confirmed XyloNet swap recovery state is unavailable.");
  }
  verifyPayrollBatchReceipt({
    binding: input.binding,
    referenceId: input.referenceId,
    receipt: await input.waitForReceipt(input.txHash),
  });
  const completedBatches = state.completedBatches.filter(
    (batch) => batch.referenceId !== input.referenceId,
  );
  completedBatches.push({ referenceId: input.referenceId, txHash: input.txHash });
  writeState(input.storage, input.binding, {
    ...state,
    stage: "payroll_in_progress",
    completedBatches,
    pendingBatchReferenceId: null,
    updatedAt: new Date().toISOString(),
  });
}

export function beginExternalPayrollBatchSubmission(input: {
  binding: ExternalPayrollXylonetBinding;
  storage: Storage;
  referenceId: string;
}) {
  const state = readState(input.storage, input.binding);
  if (!state || !state.verifiedActualOutput) {
    throw new Error("Confirmed XyloNet swap recovery state is unavailable.");
  }
  if (
    state.pendingBatchReferenceId &&
    state.pendingBatchReferenceId !== input.referenceId
  ) {
    throw new Error(
      `Payroll batch ${state.pendingBatchReferenceId} has an unresolved submission outcome.`,
    );
  }
  writeState(input.storage, input.binding, {
    ...state,
    stage: "payroll_in_progress",
    pendingBatchReferenceId: input.referenceId,
    updatedAt: new Date().toISOString(),
  });
}

export function clearExternalPayrollBatchSubmission(input: {
  binding: ExternalPayrollXylonetBinding;
  storage: Storage;
  referenceId: string;
}) {
  const state = readState(input.storage, input.binding);
  if (!state || state.pendingBatchReferenceId !== input.referenceId) return;
  writeState(input.storage, input.binding, {
    ...state,
    pendingBatchReferenceId: null,
    updatedAt: new Date().toISOString(),
  });
}

export async function getRecoveredExternalPayrollBatch(input: {
  binding: ExternalPayrollXylonetBinding;
  storage: Storage;
  referenceId: string;
  waitForReceipt: (hash: Hex) => Promise<ConfirmedReceipt>;
}): Promise<Hex | null> {
  const state = readState(input.storage, input.binding);
  const completed = state?.completedBatches.find(
    (batch) => batch.referenceId === input.referenceId,
  );
  if (!completed) {
    if (state?.pendingBatchReferenceId === input.referenceId) {
      throw new Error(
        "A prior payroll batch submission has an unknown outcome. Verify wallet activity before retrying; WizPay will not submit it again.",
      );
    }
    return null;
  }

  const receipt = await input.waitForReceipt(completed.txHash);
  verifyPayrollBatchReceipt({
    binding: input.binding,
    referenceId: input.referenceId,
    receipt,
  });
  return completed.txHash;
}
