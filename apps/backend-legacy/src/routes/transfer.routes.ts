import { Router } from "express";
import {
  getTransferStatus,
  getWallet,
  postBootstrapWallet,
  postTransfer,
} from "../controllers/transfer.controller.js";

const router = Router();

router.get("/wallet", getWallet);
router.post("/wallet/bootstrap", postBootstrapWallet);
router.post("/", postTransfer);
router.get("/:transferId", getTransferStatus);

export default router;