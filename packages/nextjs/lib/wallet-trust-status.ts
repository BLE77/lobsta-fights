import "server-only";

import { PublicKey } from "@solana/web3.js";
import { freshSupabase } from "./supabase";
import {
  getWalletTrustDecision,
  normalizeTrustedWalletAddress,
  type WalletTrustDecision,
} from "./wallet-trust";
import {
  deriveFighterDelegateSigner,
  readFighterDelegateState,
} from "./solana-programs";

export interface WalletTrustSnapshotFighter {
  id: string;
  name: string;
  verified: boolean;
  createdAt: string | null;
}

export interface WalletTrustSnapshot {
  walletAddress: string;
  trust: {
    approved: boolean;
    source: WalletTrustDecision["source"];
    label: string | null;
    reason: string | null;
    sgtAssetId: string | null;
  };
  delegate: {
    configured: boolean;
    authorized: boolean;
    revoked: boolean;
    expectedAuthority: string | null;
    onchainAuthority: string | null;
    matchesExpectedAuthority: boolean;
    nextAction: "authorize_delegate" | "rebind_delegate" | "ready_for_seekerclaw";
    message: string;
  };
  fighter: WalletTrustSnapshotFighter | null;
  canRegister: boolean;
  canQueue: boolean;
  canAutoVerifyExistingFighter: boolean;
  nextAction:
    | "register_fighter_now"
    | "queue_existing_fighter"
    | "retry_signed_registration"
    | "manual_allowlist_required";
  message: string;
}

function buildNextAction(params: {
  fighter: WalletTrustSnapshotFighter | null;
  trust: WalletTrustDecision;
}): Pick<WalletTrustSnapshot, "canRegister" | "canQueue" | "canAutoVerifyExistingFighter" | "nextAction" | "message"> {
  const { fighter, trust } = params;
  if (!fighter) {
    if (trust.approved) {
      return {
        canRegister: true,
        canQueue: false,
        canAutoVerifyExistingFighter: false,
        nextAction: "register_fighter_now",
        message: `Trusted wallet via ${trust.label ?? trust.source}. Register a fighter now and it should auto-approve.`,
      };
    }
    return {
      canRegister: true,
      canQueue: false,
      canAutoVerifyExistingFighter: false,
      nextAction: "manual_allowlist_required",
      message: "Wallet can still bet immediately, but fighter registration will stay pending until the wallet is allowlisted or a valid Seeker Genesis token is detected.",
    };
  }

  if (fighter.verified) {
    return {
      canRegister: false,
      canQueue: true,
      canAutoVerifyExistingFighter: false,
      nextAction: "queue_existing_fighter",
      message: "Existing fighter is already verified and can queue for live rumbles.",
    };
  }

  if (trust.approved) {
    return {
      canRegister: false,
      canQueue: false,
      canAutoVerifyExistingFighter: true,
      nextAction: "retry_signed_registration",
      message: `Existing fighter is still pending, but this wallet is trusted via ${trust.label ?? trust.source}. Retry the signed registration flow to auto-verify the existing fighter.`,
    };
  }

  return {
    canRegister: false,
    canQueue: false,
    canAutoVerifyExistingFighter: false,
    nextAction: "manual_allowlist_required",
    message: "Existing fighter is pending approval. Non-Seeker wallets should ask @ble77_ed or @ClawFights to allowlist the wallet.",
  };
}

export async function getWalletTrustSnapshot(walletAddressRaw: string): Promise<WalletTrustSnapshot | null> {
  const walletAddress = normalizeTrustedWalletAddress(walletAddressRaw);
  if (!walletAddress) return null;
  const walletPubkey = new PublicKey(walletAddress);
  const walletDelegateSigner = deriveFighterDelegateSigner(walletPubkey);

  const [trustDecision, fighterResult, delegateState] = await Promise.all([
    getWalletTrustDecision(walletAddress, { reserveSeekerAsset: false }),
    freshSupabase()
      .from("ucf_fighters")
      .select("id, name, verified, created_at")
      .eq("wallet_address", walletAddress)
      .maybeSingle(),
    readFighterDelegateState(walletPubkey).catch(() => null),
  ]);

  if (fighterResult.error && fighterResult.error.code !== "PGRST116") {
    throw fighterResult.error;
  }

  const fighter: WalletTrustSnapshotFighter | null = fighterResult.data
    ? {
        id: fighterResult.data.id,
        name: fighterResult.data.name,
        verified: Boolean(fighterResult.data.verified),
        createdAt: fighterResult.data.created_at ?? null,
      }
    : null;

  const nextAction = buildNextAction({ fighter, trust: trustDecision });
  const expectedAuthority = walletDelegateSigner?.publicKey.toBase58() ?? null;
  const onchainAuthority = delegateState?.authority.toBase58() ?? null;
  const matchesExpectedAuthority = Boolean(
    expectedAuthority &&
    onchainAuthority &&
    expectedAuthority === onchainAuthority &&
    !delegateState?.revoked,
  );
  const delegate = {
    configured: Boolean(walletDelegateSigner),
    authorized: Boolean(delegateState && !delegateState.revoked),
    revoked: Boolean(delegateState?.revoked),
    expectedAuthority,
    onchainAuthority,
    matchesExpectedAuthority,
    nextAction: matchesExpectedAuthority
      ? "ready_for_seekerclaw"
      : delegateState && !delegateState.revoked
        ? "rebind_delegate"
        : "authorize_delegate",
    message: matchesExpectedAuthority
      ? "SeekerClaw is authorized to fight for this wallet until you revoke it."
      : delegateState && !delegateState.revoked
        ? "A different delegate is currently authorized. Rebind to SeekerClaw to use the default trusted flow."
        : "Authorize SeekerClaw once so it can fight future rumbles without per-turn wallet signatures.",
  } as const;

  return {
    walletAddress,
    trust: {
      approved: trustDecision.approved,
      source: trustDecision.source,
      label: trustDecision.label,
      reason: trustDecision.reason,
      sgtAssetId: trustDecision.sgtAssetId,
    },
    delegate,
    fighter,
    ...nextAction,
  };
}
