import "dotenv/config";

const rawCircleApiBaseUrl = process.env.CIRCLE_API_BASE_URL;
const normalizedCircleWalletsBaseUrl =
  process.env.CIRCLE_WALLETS_BASE_URL ||
  (rawCircleApiBaseUrl
    ? rawCircleApiBaseUrl.replace(/\/v1\/?$/, "")
    : "https://api.circle.com");

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((o) => o.trim()),

  // Arc Testnet
  arcRpcUrl:
    process.env.ARC_RPC_URL ||
    process.env.RPC_URL ||
    "https://rpc.testnet.arc.network",
  arcChainId: parseInt(process.env.ARC_CHAIN_ID || "5042002", 10),

  // Contracts
  wizpayAddress: process.env.WIZPAY_ADDRESS || "",
  stablefxAdapterAddress: process.env.STABLEFX_ADAPTER_ADDRESS || "",

  // Circle StableFX (future)
  circleApiKey: process.env.CIRCLE_API_KEY || "",
  circleApiBaseUrl: rawCircleApiBaseUrl || "https://api.circle.com/v1",
  circleWalletsBaseUrl: normalizedCircleWalletsBaseUrl,
  circleStablefxBaseUrl: process.env.CIRCLE_STABLEFX_BASE_URL || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET || "",
  circleWalletSetId: process.env.CIRCLE_WALLET_SET_ID || "",
  circleWalletId: process.env.CIRCLE_WALLET_ID || "",
  circleWalletAddress: process.env.CIRCLE_WALLET_ADDRESS || "",
  circleTransferBlockchain:
    process.env.CIRCLE_TRANSFER_BLOCKCHAIN || "ARC-TESTNET",
  circleTransferTokenAddress:
    process.env.CIRCLE_TRANSFER_TOKEN_ADDRESS ||
    "0x3600000000000000000000000000000000000000",
  circleTransferFeeLevel:
    process.env.CIRCLE_TRANSFER_FEE_LEVEL || "MEDIUM",
} as const;
