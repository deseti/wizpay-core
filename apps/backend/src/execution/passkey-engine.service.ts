import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BlockchainService } from '../adapters/blockchain.service';
import { DexService } from '../adapters/dex.service';
import { AgentExecutionResult } from '../agents/agent.interface';
import { TaskStatus } from '../task/task-status.enum';
import { TaskService } from '../task/task.service';
import { TaskType } from '../task/task-type.enum';
import { TaskDetails } from '../task/task.types';

// ─── Supported passkey chains ────────────────────────────────────────────────

/**
 * EVM chains that Circle modular (passkey) wallets can sign for.
 * Solana is NOT in this set — passkey AA wallets are EVM-only.
 * Solana transfers are recorded as unsigned intents for client-side signing.
 */
const PASSKEY_EVM_CHAINS = new Set(['ARC-TESTNET', 'ETH-SEPOLIA']);

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * PasskeyEngineService — execution engine for Circle modular (passkey) wallets.
 *
 * Circle passkey wallets use Account Abstraction on EVM chains (Arc Testnet +
 * Eth Sepolia).  They do NOT have a userToken, tokenId, or any Circle W3S
 * session credential.  All execution must happen without those artifacts.
 *
 * Responsibilities per task type:
 *
 *  BRIDGE   — Records a CCTP bridge intent (external_signer mode).
 *             The user signs and submits the burn tx client-side via their
 *             passkey-controlled AA wallet.  The backend stores the intent and
 *             the frontend calls the CCTP contract directly.
 *
 *  PAYROLL  — Submits ERC-20 transfers on the specified EVM chain using the
 *             backend treasury key (BACKEND_PRIVATE_KEY).  The assumption is
 *             that the company pre-funds the backend treasury wallet, which then
 *             distributes to employees.  For Solana payroll the service returns
 *             unsigned SPL-transfer intents for client-side signing.
 *
 *  SWAP     — Delegates to DexService.prepareSwapExecution() which is already
 *             chain-agnostic.  Swap execution is returned as a payload for the
 *             frontend to submit.
 *
 * Design rules:
 *  - NEVER call createTransferChallenge, userToken, or tokenId.
 *  - ALL blockchain reads/writes go through BlockchainService.
 *  - W3S logic (CircleService, CircleBridgeService) is never touched.
 */
@Injectable()
export class PasskeyEngineService {
  private readonly logger = new Logger(PasskeyEngineService.name);

  constructor(
    private readonly blockchainService: BlockchainService,
    private readonly dexService: DexService,
    private readonly taskService: TaskService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Entry point
  // ─────────────────────────────────────────────────────────────────────────

  async execute(task: TaskDetails): Promise<AgentExecutionResult> {
    const taskType = task.type as TaskType;

    this.logger.log(
      `[passkey-engine] execute — taskId=${task.id} type=${taskType}`,
    );

    switch (taskType) {
      case TaskType.BRIDGE:
        return this.executeBridge(task);

      case TaskType.PAYROLL:
        return this.executePayroll(task);

      case TaskType.SWAP:
        return this.executeSwap(task);

      default:
        throw new BadRequestException(
          `PasskeyEngine: unsupported task type "${taskType}". ` +
            `Supported: bridge, payroll, swap.`,
        );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bridge (passkey)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record a CCTP bridge intent for an external (passkey) signer.
   *
   * The user's AA wallet holds the source USDC.  The backend cannot sign
   * on their behalf.  We record the intent and return all parameters the
   * frontend needs to execute the CCTP burn+mint cycle itself.
   *
   * This follows the existing `external_signer` bridge path already
   * understood by BridgeAgent — we produce an identical result shape so
   * the frontend polling logic requires no changes.
   */
  private async executeBridge(task: TaskDetails): Promise<AgentExecutionResult> {
    const p = task.payload;

    const amount = this.readRequired(p, 'amount');
    const sourceBlockchain =
      this.readString(p, 'sourceBlockchain') ??
      this.readRequired(p, 'sourceChain');
    const destinationBlockchain =
      this.readString(p, 'destinationBlockchain') ??
      this.readRequired(p, 'destinationChain');
    const destinationAddress = this.readRequired(p, 'destinationAddress');
    const walletAddress = this.readString(p, 'walletAddress') ?? '';
    const walletId = this.readString(p, 'walletId') ?? null;
    const referenceId =
      this.readString(p, 'referenceId') ?? `PASSKEY-BRIDGE-${task.id}`;
    const token = (this.readString(p, 'token') ?? 'USDC').toUpperCase();

    if (token !== 'USDC') {
      throw new BadRequestException(
        'PasskeyEngine bridge: only USDC is supported.',
      );
    }

    await this.taskService.logStep(
      task.id,
      'passkey.bridge.intent_recorded',
      TaskStatus.IN_PROGRESS,
      `Passkey bridge intent: ${amount} ${token} — ${sourceBlockchain} → ${destinationBlockchain}`,
      {
        context: {
          walletMode: 'PASSKEY',
          bridgeExecutionMode: 'external_signer',
          sourceBlockchain,
          destinationBlockchain,
          destinationAddress,
          walletAddress,
          walletId,
          referenceId,
        },
      },
    );

    this.logger.log(
      `[passkey-engine] bridge intent recorded — taskId=${task.id} ` +
        `source=${sourceBlockchain} dest=${destinationBlockchain}`,
    );

    return {
      agent: 'bridge',
      execution: {
        adapter: 'passkey-external-cctp-v2',
        operation: 'cctp_bridge_passkey',
        bridgeExecutionMode: 'external_signer',
        sourceAccountType: 'external_wallet',
        walletMode: 'PASSKEY',
        payload: {
          amount,
          token,
          sourceBlockchain,
          destinationBlockchain,
          destinationAddress,
          walletAddress,
          walletId,
          referenceId,
        },
        taskId: task.id,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Payroll (passkey)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute payroll transfers for a passkey-wallet user.
   *
   * EVM path (ARC-TESTNET / ETH-SEPOLIA):
   *   Submits ERC-20 transfers from the backend treasury wallet
   *   (BACKEND_PRIVATE_KEY) to each recipient.  The company must pre-fund
   *   the treasury address before initiating payroll.
   *
   * Solana path (SOLANA-DEVNET):
   *   Passkey AA wallets are EVM-only.  For Solana payroll the engine
   *   returns unsigned SPL transfer intents.  The frontend must sign and
   *   broadcast them with the user's passkey-controlled Solana wallet.
   *
   * Task payload schema:
   * {
   *   walletMode: "PASSKEY",
   *   network: "ARC-TESTNET" | "ETH-SEPOLIA" | "SOLANA-DEVNET",
   *   fromAddress: "0x..." | "<base58>",
   *   tokenAddress: "0x..." | "<base58 mint>",
   *   recipients: [{ address: string; amount: string; currency?: string }]
   * }
   */
  private async executePayroll(task: TaskDetails): Promise<AgentExecutionResult> {
    const p = task.payload;

    const network = (
      (this.readString(p, 'network') ?? 'ARC-TESTNET') as string
    ).toUpperCase();

    const fromAddress = this.readRequired(p, 'fromAddress');
    const tokenAddress = this.readRequired(p, 'tokenAddress');
    const decimals = Number(this.readString(p, 'tokenDecimals') ?? '6');

    const recipientsRaw = p.recipients as Array<{
      address: string;
      amount: string;
      currency?: string;
    }>;

    if (!Array.isArray(recipientsRaw) || recipientsRaw.length === 0) {
      throw new BadRequestException(
        'PasskeyEngine payroll: "recipients" array is required and must not be empty.',
      );
    }

    await this.taskService.logStep(
      task.id,
      'passkey.payroll.start',
      TaskStatus.IN_PROGRESS,
      `Passkey payroll: ${recipientsRaw.length} recipient(s) on ${network}`,
      { context: { walletMode: 'PASSKEY', network, fromAddress } },
    );

    // ── Solana path ──────────────────────────────────────────────────────
    if (network === 'SOLANA-DEVNET') {
      return this.executePayrollSolana(task.id, network, fromAddress, tokenAddress, recipientsRaw);
    }

    // ── EVM path ─────────────────────────────────────────────────────────
    if (!PASSKEY_EVM_CHAINS.has(network)) {
      throw new BadRequestException(
        `PasskeyEngine payroll: unsupported network "${network}". ` +
          `Supported: ARC-TESTNET, ETH-SEPOLIA, SOLANA-DEVNET.`,
      );
    }

    return this.executePayrollEvm(
      task.id,
      network,
      fromAddress,
      tokenAddress,
      decimals,
      recipientsRaw,
    );
  }

  /** EVM payroll: submit ERC-20 transfers via backend treasury key. */
  private async executePayrollEvm(
    taskId: string,
    chain: string,
    fromAddress: string,
    tokenAddress: string,
    decimals: number,
    recipients: Array<{ address: string; amount: string; currency?: string }>,
  ): Promise<AgentExecutionResult> {
    const results: Array<{
      recipient: string;
      amount: string;
      txHash: string | null;
      status: 'submitted' | 'failed';
      error?: string;
    }> = [];

    for (const recipient of recipients) {
      try {
        const amountRaw = BigInt(
          Math.round(parseFloat(recipient.amount) * 10 ** decimals),
        );
        const calldata = this.blockchainService.buildERC20TransferData(
          recipient.address,
          amountRaw,
        );

        const tx = await this.blockchainService.sendTransactionOnChain(
          {
            contractAddress: tokenAddress,
            functionName: 'transfer',
            fromAddress,
            data: calldata,
          },
          chain,
        );

        results.push({
          recipient: recipient.address,
          amount: recipient.amount,
          txHash: tx.txHash,
          status: 'submitted',
        });

        this.logger.log(
          `[passkey-engine] payroll transfer submitted — ` +
            `recipient=${recipient.address} amount=${recipient.amount} txHash=${tx.txHash}`,
        );
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : 'Unknown error';

        this.logger.error(
          `[passkey-engine] payroll transfer failed — ` +
            `recipient=${recipient.address} error="${errorMsg}"`,
        );

        results.push({
          recipient: recipient.address,
          amount: recipient.amount,
          txHash: null,
          status: 'failed',
          error: errorMsg,
        });
      }
    }

    const submitted = results.filter((r) => r.status === 'submitted').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    await this.taskService.logStep(
      taskId,
      'passkey.payroll.evm.submitted',
      TaskStatus.IN_PROGRESS,
      `Passkey EVM payroll: ${submitted}/${recipients.length} submitted` +
        (failed > 0 ? `, ${failed} failed` : ''),
    );

    if (submitted === 0 && failed > 0) {
      throw new Error(
        `Passkey payroll: all ${failed} transfer(s) failed. ` +
          `First error: ${results[0].error ?? 'Unknown'}`,
      );
    }

    return {
      agent: 'payroll',
      walletMode: 'PASSKEY',
      chain,
      totalRecipients: recipients.length,
      submitted,
      submitFailed: failed,
      results,
    };
  }

  /**
   * Solana payroll: passkey AA wallets are EVM-only.
   * Returns unsigned SPL transfer intents for client-side signing.
   * The frontend must sign and broadcast each intent via the user's
   * passkey-controlled Solana wallet using broadcastSolanaTransaction().
   */
  private async executePayrollSolana(
    taskId: string,
    network: string,
    fromAddress: string,
    mintAddress: string,
    recipients: Array<{ address: string; amount: string; currency?: string }>,
  ): Promise<AgentExecutionResult> {
    const intents = recipients.map((r) =>
      this.blockchainService.buildSolanaSplTransferIntent(
        fromAddress,
        r.address,
        r.amount,
        mintAddress,
      ),
    );

    await this.taskService.logStep(
      taskId,
      'passkey.payroll.solana.intents_built',
      TaskStatus.IN_PROGRESS,
      `Passkey Solana payroll: ${intents.length} unsigned SPL-transfer intents built. ` +
        `Client must sign and broadcast.`,
      { context: { walletMode: 'PASSKEY', network, fromAddress } },
    );

    this.logger.log(
      `[passkey-engine] Solana payroll intents built — ` +
        `taskId=${taskId} count=${intents.length}`,
    );

    return {
      agent: 'payroll',
      walletMode: 'PASSKEY',
      chain: network,
      executionMode: 'client_sign_required',
      totalRecipients: recipients.length,
      solanaTransferIntents: intents,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Swap (passkey)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Prepare swap execution via DexService.
   *
   * DexService is chain-agnostic and returns a swap execution payload.
   * For passkey wallets the swap is submitted client-side by the user's
   * AA wallet (same pattern as external_signer bridge).
   */
  private async executeSwap(task: TaskDetails): Promise<AgentExecutionResult> {
    const execution = await this.dexService.prepareSwapExecution(task);

    await this.taskService.logStep(
      task.id,
      'passkey.swap.prepared',
      TaskStatus.IN_PROGRESS,
      'Passkey swap execution payload prepared — awaiting client submission.',
      { context: { walletMode: 'PASSKEY' } },
    );

    return {
      agent: 'swap',
      walletMode: 'PASSKEY',
      execution,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private readString(
    payload: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const v = payload[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  private readRequired(
    payload: Record<string, unknown>,
    key: string,
  ): string {
    const v = this.readString(payload, key);
    if (!v) {
      throw new BadRequestException(
        `PasskeyEngine: required field "${key}" is missing or empty.`,
      );
    }
    return v;
  }
}
