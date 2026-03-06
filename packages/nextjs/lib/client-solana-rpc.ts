type ClientSolanaNetwork = "devnet" | "mainnet-beta";

const API_KEY_QUERY_PARAM_PATTERN = /(?:^|[?&])(api(?:_|-)key|x-api-key)=/i;

function safeExplicitRpcEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (API_KEY_QUERY_PARAM_PATTERN.test(value)) return null;
  return value;
}

export function getClientSolanaNetwork(): ClientSolanaNetwork {
  const explicit = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  if (explicit === "mainnet-beta") return "mainnet-beta";
  return "devnet";
}

export function getClientBettingNetwork(): ClientSolanaNetwork {
  if (process.env.NEXT_PUBLIC_BETTING_RPC_URL?.trim()) return "mainnet-beta";
  return getClientSolanaNetwork();
}

export function getSafeClientCombatRpcEndpoint(): string {
  const explicit = safeExplicitRpcEndpoint(process.env.NEXT_PUBLIC_SOLANA_RPC_URL);
  if (explicit) return explicit;

  return getClientSolanaNetwork() === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";
}

export function getSafeClientBettingRpcEndpoint(): string {
  const explicit = safeExplicitRpcEndpoint(process.env.NEXT_PUBLIC_BETTING_RPC_URL);
  if (explicit) return explicit;
  return "https://api.mainnet-beta.solana.com";
}

export function toWsEndpoint(httpEndpoint: string): string {
  if (httpEndpoint.startsWith("https://")) {
    return `wss://${httpEndpoint.slice("https://".length)}`;
  }
  if (httpEndpoint.startsWith("http://")) {
    return `ws://${httpEndpoint.slice("http://".length)}`;
  }
  return httpEndpoint;
}
