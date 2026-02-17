export interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  tokenAccount: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
  usdValue?: number;
}

export interface WalletBalances {
  solBalance: number;
  solUsdValue?: number;
  tokens: TokenBalance[];
  ichorBalance: number;
}

export interface WalletTransaction {
  signature: string;
  timestamp: number;
  type: string;
  description: string;
  fee: number;
  feePayer: string;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
  }>;
}

export interface WalletTransfer {
  signature: string;
  timestamp: number;
  from: string;
  to: string;
  amount: number;
  mint?: string;
  direction: "in" | "out";
}
