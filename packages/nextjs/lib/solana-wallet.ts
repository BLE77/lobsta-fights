/**
 * Solana Wallet Integration via Helius API
 *
 * Provides wallet balance lookups, transaction history, and transfer activity
 * using the Helius Wallet API (https://www.helius.dev/docs/wallet-api/overview).
 *
 * Environment variables:
 *   NEXT_PUBLIC_HELIUS_API_KEY - Helius API key
 *   NEXT_PUBLIC_SOLANA_NETWORK - "devnet" | "mainnet-beta" (default: "devnet")
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getHeliusApiKey(): string {
  const key = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  if (!key) throw new Error("Missing NEXT_PUBLIC_HELIUS_API_KEY");
  return key;
}

function getNetwork(): "devnet" | "mainnet-beta" {
  const net = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  if (net === "mainnet-beta") return "mainnet-beta";
  return "devnet";
}

function getHeliusBaseUrl(): string {
  const network = getNetwork();
  const key = getHeliusApiKey();
  if (network === "mainnet-beta") {
    return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  }
  return `https://devnet.helius-rpc.com/?api-key=${key}`;
}

function getHeliusApiUrl(): string {
  const network = getNetwork();
  const key = getHeliusApiKey();
  if (network === "mainnet-beta") {
    return `https://api.helius.xyz/v0`;
  }
  return `https://api-devnet.helius.xyz/v0`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  solBalance: number; // SOL in lamports converted to SOL
  solUsdValue?: number;
  tokens: TokenBalance[];
  ichorBalance: number; // ICHOR token balance (0 if not found)
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
    amount: number; // in lamports
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
  mint?: string; // undefined for native SOL
  direction: "in" | "out";
}

// ---------------------------------------------------------------------------
// ICHOR Token Mint (placeholder - replace with actual mint address)
// ---------------------------------------------------------------------------

const ICHOR_TOKEN_MINT =
  process.env.NEXT_PUBLIC_ICHOR_TOKEN_MINT ??
  "ICHoRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // placeholder

const LAMPORTS_PER_SOL = 1_000_000_000;

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Fetch SOL and token balances for a wallet, including ICHOR balance.
 */
export async function getWalletBalances(
  walletAddress: string,
): Promise<WalletBalances> {
  const apiKey = getHeliusApiKey();
  const rpcUrl = getHeliusBaseUrl();

  // Fetch native SOL balance via RPC
  const solBalanceRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [walletAddress],
    }),
    cache: "no-store",
  });

  const solBalanceData = await solBalanceRes.json();
  const lamports: number = solBalanceData?.result?.value ?? 0;
  const solBalance = lamports / LAMPORTS_PER_SOL;

  // Fetch token balances via Helius DAS (Digital Asset Standard) API
  const tokenRes = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getAssetsByOwner",
      params: {
        ownerAddress: walletAddress,
        displayOptions: {
          showFungible: true,
          showNativeBalance: true,
        },
      },
    }),
    cache: "no-store",
  });

  const tokenData = await tokenRes.json();

  const tokens: TokenBalance[] = [];
  let ichorBalance = 0;

  if (tokenData?.result?.items) {
    for (const item of tokenData.result.items) {
      if (item.interface === "FungibleToken" || item.interface === "FungibleAsset") {
        const info = item.token_info;
        if (!info) continue;

        const balance: TokenBalance = {
          mint: item.id,
          amount: (info.balance ?? 0) / Math.pow(10, info.decimals ?? 0),
          decimals: info.decimals ?? 0,
          tokenAccount: info.associated_token_address ?? "",
          symbol: info.symbol,
          name: item.content?.metadata?.name,
          logoURI: item.content?.links?.image,
          usdValue: info.price_info?.total_price,
        };

        tokens.push(balance);

        if (item.id === ICHOR_TOKEN_MINT) {
          ichorBalance = balance.amount;
        }
      }
    }
  }

  // Check native balance USD from DAS response
  const nativeBalance = tokenData?.result?.nativeBalance;
  const solUsdValue = nativeBalance?.total_price;

  return {
    solBalance,
    solUsdValue,
    tokens,
    ichorBalance,
  };
}

/**
 * Fetch transaction history for a wallet (betting/payout activity).
 * Uses the Helius Enhanced Transactions API.
 */
export async function getWalletHistory(
  walletAddress: string,
  limit: number = 20,
): Promise<WalletTransaction[]> {
  const apiKey = getHeliusApiKey();
  const apiUrl = getHeliusApiUrl();

  const url = `${apiUrl}/addresses/${walletAddress}/transactions?api-key=${apiKey}&limit=${limit}`;

  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Helius API error (${res.status}): ${text}`);
  }

  const data = await res.json();

  return (data as any[]).map((tx) => ({
    signature: tx.signature,
    timestamp: tx.timestamp,
    type: tx.type ?? "UNKNOWN",
    description: tx.description ?? "",
    fee: tx.fee ?? 0,
    feePayer: tx.feePayer ?? "",
    nativeTransfers: (tx.nativeTransfers ?? []).map((nt: any) => ({
      fromUserAccount: nt.fromUserAccount,
      toUserAccount: nt.toUserAccount,
      amount: nt.amount,
    })),
    tokenTransfers: (tx.tokenTransfers ?? []).map((tt: any) => ({
      fromUserAccount: tt.fromUserAccount,
      toUserAccount: tt.toUserAccount,
      mint: tt.mint,
      tokenAmount: tt.tokenAmount,
    })),
  }));
}

/**
 * Fetch recent transfers for a wallet, normalized to a simple format.
 * Combines native SOL transfers and token transfers.
 */
export async function getWalletTransfers(
  walletAddress: string,
  limit: number = 20,
): Promise<WalletTransfer[]> {
  const transactions = await getWalletHistory(walletAddress, limit);
  const transfers: WalletTransfer[] = [];

  for (const tx of transactions) {
    // Native SOL transfers
    for (const nt of tx.nativeTransfers) {
      if (nt.fromUserAccount === walletAddress || nt.toUserAccount === walletAddress) {
        transfers.push({
          signature: tx.signature,
          timestamp: tx.timestamp,
          from: nt.fromUserAccount,
          to: nt.toUserAccount,
          amount: nt.amount / LAMPORTS_PER_SOL,
          direction: nt.fromUserAccount === walletAddress ? "out" : "in",
        });
      }
    }

    // Token transfers
    for (const tt of tx.tokenTransfers) {
      if (tt.fromUserAccount === walletAddress || tt.toUserAccount === walletAddress) {
        transfers.push({
          signature: tx.signature,
          timestamp: tx.timestamp,
          from: tt.fromUserAccount,
          to: tt.toUserAccount,
          amount: tt.tokenAmount,
          mint: tt.mint,
          direction: tt.fromUserAccount === walletAddress ? "out" : "in",
        });
      }
    }
  }

  return transfers;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Truncate a wallet address for display: "AbCd...xYz1"
 */
export function truncateAddress(address: string, chars: number = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format SOL amount for display (up to 4 decimal places).
 */
export function formatSol(amount: number): string {
  if (amount === 0) return "0";
  if (amount < 0.0001) return "<0.0001";
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}
