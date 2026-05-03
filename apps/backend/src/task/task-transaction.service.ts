import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  AppendTransactionInput,
  TaskTransactionRecord,
  TxStatus,
  UpdateTransactionInput,
} from './task.types';

/**
 * TaskTransactionService — tracks on-chain transaction records attached to tasks.
 *
 * Extracted from TaskService to keep transaction-tracking concerns separate.
 * TaskService delegates to this; direct injection is fine where TaskService
 * is not needed.
 */
@Injectable()
export class TaskTransactionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a new transaction record to a task.
   * Called by PayrollAgent after each CircleService.transfer() call.
   */
  async appendTransaction(
    input: AppendTransactionInput,
  ): Promise<TaskTransactionRecord> {
    const tx = await this.prisma.taskTransaction.create({
      data: {
        taskId: input.taskId,
        txId: input.txId,
        recipient: input.recipient,
        amount: input.amount,
        currency: input.currency,
        batchIndex: input.batchIndex,
        status: 'pending',
      },
    });

    return this.mapTransaction(tx);
  }

  /**
   * Update a transaction's status, txHash, errorReason, or pollAttempts.
   * Called by TransactionPollerService after each poll.
   */
  async updateTransaction(
    txId: string,
    update: UpdateTransactionInput,
  ): Promise<TaskTransactionRecord> {
    const existing = await this.prisma.taskTransaction.findFirst({
      where: { txId },
    });

    if (!existing) {
      throw new NotFoundException(`Transaction ${txId} not found`);
    }

    const tx = await this.prisma.taskTransaction.update({
      where: { id: existing.id },
      data: {
        status: update.status,
        ...(update.txHash !== undefined ? { txHash: update.txHash } : {}),
        ...(update.errorReason !== undefined
          ? { errorReason: update.errorReason }
          : {}),
        ...(update.pollAttempts !== undefined
          ? { pollAttempts: update.pollAttempts }
          : {}),
      },
    });

    return this.mapTransaction(tx);
  }

  /**
   * Get all transactions for a task, ordered by batchIndex then createdAt.
   */
  async getTaskTransactions(
    taskId: string,
  ): Promise<TaskTransactionRecord[]> {
    const txs = await this.prisma.taskTransaction.findMany({
      where: { taskId },
      orderBy: [{ batchIndex: 'asc' }, { createdAt: 'asc' }],
    });

    return txs.map((tx) => this.mapTransaction(tx));
  }

  /**
   * Check if all transactions for a task have reached a terminal state.
   * Returns aggregation counts + whether the task is ready for finalization.
   */
  async getTransactionAggregation(taskId: string): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    allTerminal: boolean;
    txHashes: string[];
  }> {
    const txs = await this.prisma.taskTransaction.findMany({
      where: { taskId },
      select: { status: true, txHash: true },
    });

    const total = txs.length;
    const completed = txs.filter((tx) => tx.status === 'completed').length;
    const failed = txs.filter((tx) => tx.status === 'failed').length;
    const pending = total - completed - failed;
    const txHashes = txs
      .filter((tx) => tx.txHash != null)
      .map((tx) => tx.txHash as string);

    return {
      total,
      completed,
      failed,
      pending,
      allTerminal: pending === 0 && total > 0,
      txHashes,
    };
  }

  mapTransaction(tx: {
    id: string;
    taskId: string;
    txId: string;
    recipient: string;
    amount: string;
    currency: string;
    status: string;
    txHash: string | null;
    errorReason: string | null;
    batchIndex: number;
    pollAttempts: number;
    createdAt: Date;
    updatedAt: Date;
  }): TaskTransactionRecord {
    return {
      id: tx.id,
      taskId: tx.taskId,
      txId: tx.txId,
      recipient: tx.recipient,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status as TxStatus,
      txHash: tx.txHash,
      errorReason: tx.errorReason,
      batchIndex: tx.batchIndex,
      pollAttempts: tx.pollAttempts,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  }
}
