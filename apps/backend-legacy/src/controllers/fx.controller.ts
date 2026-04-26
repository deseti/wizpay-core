import type { Request, Response } from "express";
import {
  requestQuote,
  executeTrade,
  getTradeStatus,
} from "../services/stablefx.service.js";

/**
 * POST /api/fx/quote
 * Body: { sourceCurrency, targetCurrency, sourceAmount }
 */
export function postQuote(req: Request, res: Response): void {
  try {
    const { sourceCurrency, targetCurrency, sourceAmount } = req.body;

    if (!sourceCurrency || !targetCurrency || !sourceAmount) {
      res.status(400).json({
        error: "Missing required fields: sourceCurrency, targetCurrency, sourceAmount",
      });
      return;
    }

    const quote = requestQuote({ sourceCurrency, targetCurrency, sourceAmount });
    res.json({ data: quote });
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
}

/**
 * POST /api/fx/execute
 * Body: { quoteId, senderAddress, referenceId? }
 */
export function postExecute(req: Request, res: Response): void {
  try {
    const { quoteId, senderAddress, referenceId } = req.body;

    if (!quoteId || !senderAddress) {
      res.status(400).json({
        error: "Missing required fields: quoteId, senderAddress",
      });
      return;
    }

    const trade = executeTrade({ quoteId, senderAddress, referenceId });
    res.status(201).json({ data: trade });
  } catch (err: any) {
    res.status(422).json({ error: err.message });
  }
}

/**
 * GET /api/fx/status/:tradeId
 */
export function getStatus(req: Request, res: Response): void {
  const tradeId = req.params.tradeId as string;

  if (!tradeId) {
    res.status(400).json({ error: "Missing tradeId parameter" });
    return;
  }

  const trade = getTradeStatus(tradeId);
  res.json({ data: trade });
}
