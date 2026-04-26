import type { Request, Response } from "express";
import {
  CircleTransferError,
  bootstrapTransferWallet,
  createCircleTransfer,
  getCircleTransferStatus,
  getTransferWallet,
} from "../services/circle.service.js";

interface BootstrapWalletBody {
  walletSetId?: string;
  walletSetName?: string;
  walletName?: string;
  refId?: string;
}

interface CreateTransferBody {
  destinationAddress?: string;
  amount?: string;
  referenceId?: string;
  tokenAddress?: string;
  walletId?: string;
  walletAddress?: string;
  blockchain?: string;
}

export async function getWallet(_req: Request, res: Response): Promise<void> {
  try {
    const wallet = await getTransferWallet();
    res.json({ data: wallet });
  } catch (error) {
    sendTransferError(res, error);
  }
}

export async function postBootstrapWallet(
  req: Request<unknown, unknown, BootstrapWalletBody>,
  res: Response
): Promise<void> {
  try {
    const wallet = await bootstrapTransferWallet({
      walletSetId: req.body.walletSetId,
      walletSetName: req.body.walletSetName,
      walletName: req.body.walletName,
      refId: req.body.refId,
    });

    res.status(201).json({ data: wallet });
  } catch (error) {
    sendTransferError(res, error);
  }
}

export async function postTransfer(
  req: Request<unknown, unknown, CreateTransferBody>,
  res: Response
): Promise<void> {
  try {
    const { destinationAddress, amount } = req.body;

    if (!isNonEmptyString(destinationAddress) || !isNonEmptyString(amount)) {
      res.status(400).json({
        error: "Missing required fields: destinationAddress, amount",
      });
      return;
    }

    const transfer = await createCircleTransfer({
      destinationAddress,
      amount,
      referenceId: req.body.referenceId,
      tokenAddress: req.body.tokenAddress,
      walletId: req.body.walletId,
      walletAddress: req.body.walletAddress,
      blockchain: req.body.blockchain,
    });

    res.status(201).json({ data: transfer });
  } catch (error) {
    sendTransferError(res, error);
  }
}

export async function getTransferStatus(
  req: Request<{ transferId: string }>,
  res: Response
): Promise<void> {
  try {
    const transferId = req.params.transferId;

    if (!isNonEmptyString(transferId)) {
      res.status(400).json({ error: "Missing transferId parameter" });
      return;
    }

    const transfer = await getCircleTransferStatus(transferId);
    res.json({ data: transfer });
  } catch (error) {
    sendTransferError(res, error);
  }
}

function sendTransferError(res: Response, error: unknown): void {
  if (error instanceof CircleTransferError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Internal error";
  res.status(500).json({ error: message });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}