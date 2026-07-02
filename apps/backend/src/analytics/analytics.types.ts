export type WizPayAnalyticsTokenVolume = {
  symbol: 'USDC' | 'EURC';
  decimals: 6;
  in: number;
  out: number;
  gross: number;
  net: number;
};

export type WizPayAnalyticsVolume = {
  source: string;
  coverage: string;
  amountFormat: string;
  tokenDecimals: number;
  settledVolume: number;
  settledVolumeDisplay: string;
  grossMovement: number;
  grossMovementDisplay: string;
  totalIn: number;
  totalOut: number;
  net: number;
  tokens: WizPayAnalyticsTokenVolume[];
};

export type WizPayAnalyticsSnapshot = {
  contractName: 'WizPay';
  network: 'Arc Testnet';
  contractAddress: string;
  transactions: number;
  transfers: number;
  gasUsed: number;
  balance: string;
  lastBalanceUpdateBlock: number;
  updatedAt: string;
  source: string;
  volume: WizPayAnalyticsVolume;
};
