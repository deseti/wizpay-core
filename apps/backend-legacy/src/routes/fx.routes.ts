import { Router } from "express";
import {
  postQuote,
  postExecute,
  getStatus,
} from "../controllers/fx.controller.js";

const router = Router();

router.post("/quote", postQuote);
router.post("/execute", postExecute);
router.get("/status/:tradeId", getStatus);

export default router;
