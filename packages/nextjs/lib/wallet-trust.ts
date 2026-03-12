import "server-only";

import {
  getMetadataPointerState,
  getMint,
  getTokenGroupMemberState,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAdminConfig, setAdminConfig } from "~~/lib/rumble-persistence";

const WALLET_ALLOWLIST_ADMIN_KEY = "wallet_allowlist_v1";
const USED_SEEKER_ASSETS_ADMIN_KEY = "used_seeker_genesis_assets_v1";

export type WalletTrustSource = "env_allowlist" | "manual_allowlist" | "seeker_genesis";

export interface WalletAllowlistEntry {
  walletAddress: string;
  source: WalletTrustSource;
  active: boolean;
  label: string | null;
  notes: string | null;
  sgtAssetId: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletTrustDecision {
  approved: boolean;
  source: WalletTrustSource | null;
  reason: string | null;
  label: string | null;
  sgtAssetId: string | null;
}

interface UsedSeekerAssetRecord {
  assetId: string;
  walletAddress: string;
  fighterId: string | null;
  approvedAt: string;
}

interface SeekerGenesisConfig {
  collectionMint: string | null;
  metadataAddress: string | null;
  verifiedCreator: string | null;
  updateAuthority: string | null;
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\n\r\t ]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function normalizeTrustedWalletAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function readSeekerGenesisConfig(): SeekerGenesisConfig {
  return {
    collectionMint: normalizeTrustedWalletAddress(
      process.env.SEEKER_GENESIS_GROUP_ADDRESS
      || process.env.SEEKER_GENESIS_COLLECTION_MINT,
    ),
    metadataAddress: normalizeTrustedWalletAddress(process.env.SEEKER_GENESIS_METADATA_ADDRESS),
    verifiedCreator: normalizeTrustedWalletAddress(process.env.SEEKER_GENESIS_VERIFIED_CREATOR),
    updateAuthority: normalizeTrustedWalletAddress(process.env.SEEKER_GENESIS_UPDATE_AUTHORITY),
  };
}

function hasSeekerGenesisConfig(config: SeekerGenesisConfig): boolean {
  return Boolean(
    config.collectionMint
    || config.metadataAddress
    || config.verifiedCreator
    || config.updateAuthority,
  );
}

function getHeliusMainnetRpcUrl(): string | null {
  const key =
    process.env.HELIUS_MAINNET_API_KEY?.trim()
    || process.env.HELIUS_API_KEY?.trim()
    || "";
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

function parseWalletAllowlist(raw: unknown): WalletAllowlistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WalletAllowlistEntry[] = [];
  for (const value of raw) {
    const walletAddress = normalizeTrustedWalletAddress((value as any)?.walletAddress);
    if (!walletAddress) continue;
    out.push({
      walletAddress,
      source:
        (value as any)?.source === "seeker_genesis"
        || (value as any)?.source === "env_allowlist"
        ? (value as any).source
        : "manual_allowlist",
      active: (value as any)?.active !== false,
      label: typeof (value as any)?.label === "string" ? (value as any).label.trim() || null : null,
      notes: typeof (value as any)?.notes === "string" ? (value as any).notes.trim() || null : null,
      sgtAssetId: typeof (value as any)?.sgtAssetId === "string" ? (value as any).sgtAssetId.trim() || null : null,
      approvedBy:
        typeof (value as any)?.approvedBy === "string"
          ? (value as any).approvedBy.trim() || null
          : null,
      createdAt:
        typeof (value as any)?.createdAt === "string"
          ? (value as any).createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof (value as any)?.updatedAt === "string"
          ? (value as any).updatedAt
          : new Date().toISOString(),
    });
  }
  return out;
}

function parseUsedSeekerAssets(raw: unknown): UsedSeekerAssetRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: UsedSeekerAssetRecord[] = [];
  for (const value of raw) {
    const assetId = typeof (value as any)?.assetId === "string" ? (value as any).assetId.trim() : "";
    const walletAddress = normalizeTrustedWalletAddress((value as any)?.walletAddress);
    if (!assetId || !walletAddress) continue;
    out.push({
      assetId,
      walletAddress,
      fighterId: typeof (value as any)?.fighterId === "string" ? (value as any).fighterId.trim() || null : null,
      approvedAt:
        typeof (value as any)?.approvedAt === "string"
          ? (value as any).approvedAt
          : new Date().toISOString(),
    });
  }
  return out;
}

function getEnvAllowlistSet(): Set<string> {
  const wallets = parseCsv(process.env.UCF_WALLET_ALLOWLIST).map(normalizeTrustedWalletAddress).filter(Boolean) as string[];
  return new Set(wallets);
}

function matchGrouping(
  grouping: unknown,
  groupKey: string,
  expectedValue: string,
): boolean {
  if (!Array.isArray(grouping)) return false;
  return grouping.some((entry) => {
    const key = typeof (entry as any)?.group_key === "string"
      ? (entry as any).group_key
      : typeof (entry as any)?.groupKey === "string"
        ? (entry as any).groupKey
        : "";
    const value = typeof (entry as any)?.group_value === "string"
      ? (entry as any).group_value
      : typeof (entry as any)?.groupValue === "string"
        ? (entry as any).groupValue
        : "";
    return key === groupKey && value === expectedValue;
  });
}

export function seekerAssetMatchesConfig(
  asset: any,
  config: SeekerGenesisConfig,
): boolean {
  if (!asset || !hasSeekerGenesisConfig(config)) return false;

  if (
    config.collectionMint &&
    matchGrouping(asset.grouping, "collection", config.collectionMint)
  ) {
    return true;
  }

  const creators = Array.isArray(asset.creators) ? asset.creators : [];
  if (config.verifiedCreator) {
    const creatorMatch = creators.some((creator: any) => {
      const address = normalizeTrustedWalletAddress(creator?.address);
      return address === config.verifiedCreator && creator?.verified === true;
    });
    if (creatorMatch) return true;
  }

  const authorities = Array.isArray(asset.authorities) ? asset.authorities : [];
  if (config.updateAuthority) {
    const authorityMatch = authorities.some((authority: any) => {
      const address = normalizeTrustedWalletAddress(authority?.address);
      return address === config.updateAuthority;
    });
    if (authorityMatch) return true;
  }

  return false;
}

function positiveRawTokenAmount(raw: unknown): boolean {
  try {
    return BigInt(typeof raw === "string" ? raw : String(raw ?? "0")) > 0n;
  } catch {
    return false;
  }
}

async function listOwnedToken2022Mints(walletAddress: string, rpcUrl: string): Promise<string[]> {
  const ownedMints = new Set<string>();
  let paginationKey: string | null = null;

  do {
    const response: Response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "seeker-token-accounts",
        method: "getTokenAccountsByOwnerV2",
        params: [
          walletAddress,
          { programId: TOKEN_2022_PROGRAM_ID.toBase58() },
          {
            encoding: "jsonParsed",
            limit: 1000,
            ...(paginationKey ? { paginationKey } : {}),
          },
        ],
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Helius getTokenAccountsByOwnerV2 failed (${response.status}): ${text}`);
    }

    const payload: any = await response.json();
    const items = Array.isArray(payload?.result?.value) ? payload.result.value : [];
    for (const item of items) {
      const mint = normalizeTrustedWalletAddress(item?.account?.data?.parsed?.info?.mint);
      const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (!mint || !positiveRawTokenAmount(amount)) continue;
      ownedMints.add(mint);
    }

    paginationKey =
      typeof payload?.result?.paginationKey === "string" && payload.result.paginationKey.trim()
        ? payload.result.paginationKey.trim()
        : null;
  } while (paginationKey);

  return [...ownedMints];
}

async function fetchHeliusAssetByMint(rpcUrl: string, mintAddress: string): Promise<any | null> {
  const response: Response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seeker-asset",
      method: "getAsset",
      params: { id: mintAddress },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Helius getAsset failed (${response.status}): ${text}`);
  }

  const payload: any = await response.json();
  return payload?.result ?? null;
}

async function mintMatchesSeekerGenesis(
  connection: Connection,
  mintAddress: string,
  config: SeekerGenesisConfig,
): Promise<boolean> {
  const mintKey = new PublicKey(mintAddress);
  const mintInfo = await getMint(connection, mintKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const metadataPointerState = getMetadataPointerState(mintInfo);
  const groupMemberState = getTokenGroupMemberState(mintInfo);

  if (
    config.metadataAddress
    && metadataPointerState?.metadataAddress?.toBase58() === config.metadataAddress
  ) {
    return true;
  }

  if (
    config.collectionMint
    && groupMemberState?.group?.toBase58() === config.collectionMint
  ) {
    return true;
  }

  if (config.updateAuthority) {
    const tokenMetadata = await getTokenMetadata(
      connection,
      mintKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    ).catch(() => null);
    const updateAuthority = normalizeTrustedWalletAddress(
      tokenMetadata?.updateAuthority?.toBase58?.()
      ?? tokenMetadata?.updateAuthority,
    );
    if (updateAuthority === config.updateAuthority) {
      return true;
    }
  }

  return false;
}

export async function listWalletAllowlistEntries(): Promise<WalletAllowlistEntry[]> {
  const envEntries = [...getEnvAllowlistSet()].map<WalletAllowlistEntry>((walletAddress) => {
    const now = new Date().toISOString();
    return {
      walletAddress,
      source: "env_allowlist",
      active: true,
      label: "ENV allowlist",
      notes: null,
      sgtAssetId: null,
      approvedBy: "env",
      createdAt: now,
      updatedAt: now,
    };
  });

  const dbEntries = parseWalletAllowlist(await getAdminConfig(WALLET_ALLOWLIST_ADMIN_KEY));
  const merged = new Map<string, WalletAllowlistEntry>();
  for (const entry of [...dbEntries, ...envEntries]) {
    merged.set(entry.walletAddress, entry);
  }
  return [...merged.values()].sort((a, b) => a.walletAddress.localeCompare(b.walletAddress));
}

export async function upsertWalletAllowlistEntry(input: {
  walletAddress: string;
  label?: string | null;
  notes?: string | null;
  approvedBy?: string | null;
  source?: WalletTrustSource;
  sgtAssetId?: string | null;
  active?: boolean;
}): Promise<WalletAllowlistEntry> {
  const walletAddress = normalizeTrustedWalletAddress(input.walletAddress);
  if (!walletAddress) throw new Error("Invalid wallet address");

  const entries = parseWalletAllowlist(await getAdminConfig(WALLET_ALLOWLIST_ADMIN_KEY));
  const now = new Date().toISOString();
  const existing = entries.find((entry) => entry.walletAddress === walletAddress);

  const next: WalletAllowlistEntry = {
    walletAddress,
    source: input.source ?? existing?.source ?? "manual_allowlist",
    active: input.active ?? true,
    label: input.label ?? existing?.label ?? null,
    notes: input.notes ?? existing?.notes ?? null,
    sgtAssetId: input.sgtAssetId ?? existing?.sgtAssetId ?? null,
    approvedBy: input.approvedBy ?? existing?.approvedBy ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const filtered = entries.filter((entry) => entry.walletAddress !== walletAddress);
  filtered.push(next);
  await setAdminConfig(WALLET_ALLOWLIST_ADMIN_KEY, filtered);
  return next;
}

export async function removeWalletAllowlistEntry(walletAddressRaw: string): Promise<boolean> {
  const walletAddress = normalizeTrustedWalletAddress(walletAddressRaw);
  if (!walletAddress) return false;
  const entries = parseWalletAllowlist(await getAdminConfig(WALLET_ALLOWLIST_ADMIN_KEY));
  const filtered = entries.filter((entry) => entry.walletAddress !== walletAddress);
  if (filtered.length === entries.length) return false;
  await setAdminConfig(WALLET_ALLOWLIST_ADMIN_KEY, filtered);
  return true;
}

async function listUsedSeekerAssets(): Promise<UsedSeekerAssetRecord[]> {
  return parseUsedSeekerAssets(await getAdminConfig(USED_SEEKER_ASSETS_ADMIN_KEY));
}

async function markSeekerAssetUsed(params: {
  assetId: string;
  walletAddress: string;
  fighterId?: string | null;
}): Promise<void> {
  if (!params.assetId) return;
  const walletAddress = normalizeTrustedWalletAddress(params.walletAddress);
  if (!walletAddress) return;
  const used = await listUsedSeekerAssets();
  const now = new Date().toISOString();
  const filtered = used.filter((entry) => entry.assetId !== params.assetId);
  filtered.push({
    assetId: params.assetId,
    walletAddress,
    fighterId: params.fighterId ?? null,
    approvedAt: now,
  });
  await setAdminConfig(USED_SEEKER_ASSETS_ADMIN_KEY, filtered);
}

async function findSeekerGenesisAsset(walletAddress: string): Promise<{ assetId: string } | null> {
  const config = readSeekerGenesisConfig();
  if (!hasSeekerGenesisConfig(config)) return null;
  const rpcUrl = getHeliusMainnetRpcUrl();
  if (!rpcUrl) return null;
  const connection = new Connection(rpcUrl, "confirmed");
  const ownedMints = await listOwnedToken2022Mints(walletAddress, rpcUrl);

  for (const mintAddress of ownedMints) {
    try {
      if (await mintMatchesSeekerGenesis(connection, mintAddress, config)) {
        return { assetId: mintAddress };
      }
    } catch {
      // Ignore parse issues for non-matching Token-2022 assets and keep scanning.
    }

    if (!config.verifiedCreator && !config.collectionMint && !config.updateAuthority) {
      continue;
    }

    try {
      const asset = await fetchHeliusAssetByMint(rpcUrl, mintAddress);
      if (asset && seekerAssetMatchesConfig(asset, config)) {
        return { assetId: mintAddress };
      }
    } catch {
      // Ignore fallback lookup failures and keep scanning other mints.
    }
  }

  return null;
}

export async function getWalletTrustDecision(walletAddressRaw: string): Promise<WalletTrustDecision> {
  const walletAddress = normalizeTrustedWalletAddress(walletAddressRaw);
  if (!walletAddress) {
    return {
      approved: false,
      source: null,
      reason: "Invalid wallet address",
      label: null,
      sgtAssetId: null,
    };
  }

  if (getEnvAllowlistSet().has(walletAddress)) {
    return {
      approved: true,
      source: "env_allowlist",
      reason: "Wallet matched environment allowlist",
      label: "ENV allowlist",
      sgtAssetId: null,
    };
  }

  const allowlist = parseWalletAllowlist(await getAdminConfig(WALLET_ALLOWLIST_ADMIN_KEY));
  const trustedEntry = allowlist.find((entry) => entry.active && entry.walletAddress === walletAddress);
  if (trustedEntry) {
    return {
      approved: true,
      source: trustedEntry.source,
      reason: "Wallet matched manual allowlist",
      label: trustedEntry.label,
      sgtAssetId: trustedEntry.sgtAssetId,
    };
  }

  const seekerAsset = await findSeekerGenesisAsset(walletAddress);
  if (!seekerAsset) {
    return {
      approved: false,
      source: null,
      reason: "Wallet is not allowlisted and no Seeker Genesis Token was found",
      label: null,
      sgtAssetId: null,
    };
  }

  const usedAssets = await listUsedSeekerAssets();
  const priorUse = usedAssets.find((entry) => entry.assetId === seekerAsset.assetId);
  if (priorUse && priorUse.walletAddress !== walletAddress) {
    return {
      approved: false,
      source: null,
      reason: "Seeker Genesis Token was already used by another wallet",
      label: null,
      sgtAssetId: seekerAsset.assetId,
    };
  }

  return {
    approved: true,
    source: "seeker_genesis",
    reason: "Wallet owns a Seeker Genesis Token",
    label: "Seeker Genesis",
    sgtAssetId: seekerAsset.assetId,
  };
}

export async function rememberWalletTrustDecision(params: {
  walletAddress: string;
  decision: WalletTrustDecision;
  fighterId?: string | null;
}): Promise<void> {
  const walletAddress = normalizeTrustedWalletAddress(params.walletAddress);
  if (!walletAddress || !params.decision.approved || !params.decision.source) return;

  if (params.decision.source === "seeker_genesis") {
    await upsertWalletAllowlistEntry({
      walletAddress,
      label: params.decision.label,
      notes: "Auto-approved from Seeker Genesis ownership",
      approvedBy: "system",
      source: "seeker_genesis",
      sgtAssetId: params.decision.sgtAssetId,
      active: true,
    });
    if (params.decision.sgtAssetId) {
      await markSeekerAssetUsed({
        assetId: params.decision.sgtAssetId,
        walletAddress,
        fighterId: params.fighterId,
      });
    }
  }
}
