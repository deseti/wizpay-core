export const ARC_TESTNET_RPC_URL = 'https://rpc.testnet.arc.io';

export function readArcTestnetRpcUrl() {
  const configured = process.env.ARC_TESTNET_RPC_URL?.trim();

  if (configured && configured !== ARC_TESTNET_RPC_URL) {
    throw new Error(
      `ARC_TESTNET_RPC_URL must be exactly ${ARC_TESTNET_RPC_URL}.`,
    );
  }

  return ARC_TESTNET_RPC_URL;
}
