"use client";

interface PendingRumbleClaim {
  rumble_id: string;
  claimable_sol: number;
  onchain_claimable_sol: number | null;
  claim_method: "onchain" | "offchain";
  onchain_rumble_state?: "betting" | "combat" | "payout" | "complete" | null;
  onchain_payout_ready?: boolean;
}

interface ClaimBalance {
  payout_mode: "instant" | "accrue_claim";
  claimable_sol: number;
  legacy_claimable_sol: number;
  total_pending_claimable_sol: number;
  claimed_sol: number;
  unsettled_sol: number;
  orphaned_stale_sol?: number;
  onchain_claimable_sol_total: number;
  onchain_pending_not_ready_sol?: number;
  onchain_claim_ready: boolean;
  pending_rumbles: PendingRumbleClaim[];
}

interface ClaimBalancePanelProps {
  balance: ClaimBalance | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  onClaim: () => void;
}

export default function ClaimBalancePanel({
  balance,
  loading,
  pending,
  error,
  onClaim,
}: ClaimBalancePanelProps) {
  const payoutMode = balance?.payout_mode ?? "accrue_claim";
  const onchainClaimable = balance?.claimable_sol ?? 0;
  const onchainPendingNotReady = balance?.onchain_pending_not_ready_sol ?? 0;
  const pendingRumbles = Array.isArray(balance?.pending_rumbles) ? balance.pending_rumbles : [];
  const canClaim =
    payoutMode === "accrue_claim" &&
    (balance?.onchain_claim_ready ?? false) &&
    onchainClaimable > 0 &&
    !pending;
  const initialLoading = loading && !balance;

  const buttonLabel = pending
    ? "CLAIMING..."
    : initialLoading
      ? "LOADING..."
    : canClaim
        ? "CLAIM ALL WINS"
        : payoutMode !== "accrue_claim"
          ? "INSTANT MODE"
          : onchainPendingNotReady > 0
            ? "FIGHT IN PROGRESS"
            : "NO CLAIMABLE WINS";

  return (
    <div className="bg-stone-900/70 border border-stone-800 rounded-sm p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] text-stone-500 uppercase">Payout Wallet</p>
        <span
          className={`font-mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
            payoutMode === "accrue_claim"
              ? "text-green-400 border-green-700/40 bg-green-900/20"
              : "text-stone-400 border-stone-700 bg-stone-800/40"
          }`}
        >
          {payoutMode === "accrue_claim" ? "CLAIM MODE" : "INSTANT"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="border border-stone-800 rounded-sm p-2 bg-stone-950/50">
          <p className="text-stone-500 text-[10px]">Claimable (On-Chain)</p>
          <p className="text-green-400 font-bold">{onchainClaimable.toFixed(4)} SOL</p>
        </div>
        <div className="border border-stone-800 rounded-sm p-2 bg-stone-950/50">
          <p className="text-stone-500 text-[10px]">Claimed</p>
          <p className="text-amber-400 font-bold">{(balance?.claimed_sol ?? 0).toFixed(4)} SOL</p>
        </div>
      </div>

      {onchainPendingNotReady > 0 && (
        <div className="font-mono text-[10px] text-amber-500">
          Active bets not settled yet: {onchainPendingNotReady.toFixed(4)} SOL
        </div>
      )}

      {balance && pendingRumbles.length > 0 && (
        <div className="border border-stone-800 rounded-sm p-2 bg-stone-950/40">
          <p className="font-mono text-[10px] text-stone-500 mb-1 uppercase">Pending Rumbles</p>
          <div className="space-y-1">
            {pendingRumbles.slice(0, 3).map((entry) => (
              <div key={entry.rumble_id} className="flex items-center justify-between gap-2 font-mono text-[10px]">
                <span className="text-stone-500 truncate max-w-[110px]">{entry.rumble_id}</span>
                <span
                  className={
                    entry.claim_method === "onchain"
                      ? entry.onchain_payout_ready === false
                        ? "text-amber-400"
                        : "text-green-400"
                      : "text-amber-400"
                  }
                >
                  {entry.claimable_sol.toFixed(4)} SOL
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {payoutMode === "accrue_claim" && (
        <button
          onClick={onClaim}
          disabled={!canClaim}
          className={`w-full py-1.5 font-mono text-xs font-bold rounded-sm transition-all ${
            canClaim
              ? "bg-green-600 hover:bg-green-500 text-stone-950"
              : "bg-stone-800 text-stone-500 cursor-not-allowed"
          }`}
        >
          {buttonLabel}
        </button>
      )}

      {error && <p className="font-mono text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
