"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueEntry {
  fighter_id: string;
  auto_requeue: boolean;
  status: string;
}

interface Stats {
  total_rumbles: number;
  total_sol_wagered: number;
  total_ichor_minted: number;
  total_ichor_burned: number;
}

interface IchorShower {
  pool_amount: number;
  last_winner_wallet: string | null;
  last_payout: number | null;
}

interface TxSignatures {
  createRumble?: string | null;
  startCombat?: string | null;
  reportResult?: string | null;
  mintRumbleReward?: string | null;
  checkIchorShower?: string | null;
  completeRumble?: string | null;
  sweepTreasury?: string | null;
}

interface Rumble {
  id: string;
  slot_index: number;
  status: string;
  fighters: Array<{ id: string; name: string }> | string[];
  winner_id?: string | null;
  total_turns?: number;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  tx_signatures?: TxSignatures | null;
}

interface Fighter {
  id: string;
  name: string;
  wallet_address: string;
  wins: number;
  losses: number;
  draws: number;
  matches_played: number;
  points: number;
  verified: boolean;
  is_active: boolean;
}

interface DashboardData {
  queue: QueueEntry[];
  stats: Stats | null;
  ichorShower: IchorShower | null;
  activeRumbles: Rumble[];
  recentRumbles: Rumble[];
  fighters: Fighter[];
  timestamp: string;
}

interface OnChainData {
  arenaConfig: {
    admin: string;
    ichorMint: string;
    totalMinted: string;
    totalRumblesCompleted: string;
    baseReward: string;
    ichorShowerPool: string;
    treasuryVault: string;
    bump: number;
  } | null;
  rumbleConfig: {
    admin: string;
    treasury: string;
    totalRumbles: string;
    bump: number;
  } | null;
  registryConfig: {
    admin: string;
    totalFighters: string;
    bump: number;
  } | null;
  timestamp: string;
}

type Tab = "overview" | "rumbles" | "fighters" | "onchain";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPLORER_BASE = "https://explorer.solana.com/tx";

function explorerUrl(sig: string): string {
  return `${EXPLORER_BASE}/${sig}?cluster=devnet`;
}

function truncate(s: string, len = 8): string {
  if (s.length <= len * 2 + 3) return s;
  return `${s.slice(0, len)}...${s.slice(-len)}`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function formatIchor(raw: string | number): string {
  const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
  // ICHOR has 9 decimals
  return (n / 1e9).toFixed(4);
}

// ---------------------------------------------------------------------------
// Pipeline Step Component
// ---------------------------------------------------------------------------

const PIPELINE_STEPS: Array<{ key: keyof TxSignatures; label: string }> = [
  { key: "createRumble", label: "Create" },
  { key: "startCombat", label: "Combat" },
  { key: "reportResult", label: "Result" },
  { key: "mintRumbleReward", label: "Mint" },
  { key: "checkIchorShower", label: "Shower" },
  { key: "completeRumble", label: "Complete" },
  { key: "sweepTreasury", label: "Sweep" },
];

function PipelineView({ txSigs }: { txSigs: TxSignatures | null | undefined }) {
  const sigs = txSigs ?? {};
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {PIPELINE_STEPS.map((step, i) => {
        const sig = sigs[step.key];
        const hasSig = !!sig;
        return (
          <div key={step.key} className="flex items-center gap-1">
            {i > 0 && (
              <span className="text-stone-700 text-xs select-none">→</span>
            )}
            {hasSig ? (
              <a
                href={explorerUrl(sig!)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-900/40 border border-green-700/50 rounded text-[10px] font-mono text-green-400 hover:bg-green-900/60 transition-colors"
                title={sig!}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                {step.label}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-stone-800/50 border border-stone-700/50 rounded text-[10px] font-mono text-stone-500">
                <span className="w-1.5 h-1.5 rounded-full bg-stone-600" />
                {step.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status Badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    betting: "bg-amber-900/50 text-amber-400 border-amber-700/50",
    combat: "bg-red-900/50 text-red-400 border-red-700/50",
    payout: "bg-blue-900/50 text-blue-400 border-blue-700/50",
    complete: "bg-green-900/50 text-green-400 border-green-700/50",
    idle: "bg-stone-800/50 text-stone-500 border-stone-700/50",
    waiting: "bg-amber-900/50 text-amber-400 border-amber-700/50",
  };
  const cls = colors[status] ?? colors.idle;
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[10px] font-mono uppercase border rounded ${cls}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const [secret, setSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [onChain, setOnChain] = useState<OnChainData | null>(null);
  const [loading, setLoading] = useState(false);
  const secretRef = useRef("");

  // Restore session
  useEffect(() => {
    const saved = sessionStorage.getItem("ucf_admin_secret");
    if (saved) {
      secretRef.current = saved;
      setSecret(saved);
      setAuthenticated(true);
    }
  }, []);

  const headers = useCallback(
    () => ({
      "x-admin-secret": secretRef.current,
    }),
    [],
  );

  // Login
  const handleLogin = async () => {
    setAuthError("");
    try {
      const res = await fetch("/api/admin/dashboard", {
        headers: { "x-admin-secret": secret },
        cache: "no-store",
      });
      if (res.status === 401) {
        setAuthError("Invalid admin secret");
        return;
      }
      if (!res.ok) {
        setAuthError(`Error: ${res.status}`);
        return;
      }
      secretRef.current = secret;
      sessionStorage.setItem("ucf_admin_secret", secret);
      setAuthenticated(true);
      const data = await res.json();
      setDashboard(data);
    } catch (err: any) {
      setAuthError(err.message || "Connection failed");
    }
  };

  // Fetch dashboard data
  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/dashboard", {
        headers: headers(),
        cache: "no-store",
      });
      if (res.status === 401) {
        setAuthenticated(false);
        sessionStorage.removeItem("ucf_admin_secret");
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setDashboard(data);
    } catch {
      // silent
    }
  }, [headers]);

  // Fetch on-chain data
  const fetchOnChain = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/on-chain", {
        headers: headers(),
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setOnChain(data);
    } catch {
      // silent
    }
  }, [headers]);

  // Polling
  useEffect(() => {
    if (!authenticated) return;

    fetchDashboard();
    fetchOnChain();

    const dashInterval = setInterval(fetchDashboard, 5000);
    const chainInterval = setInterval(fetchOnChain, 30000);

    return () => {
      clearInterval(dashInterval);
      clearInterval(chainInterval);
    };
  }, [authenticated, fetchDashboard, fetchOnChain]);

  // ---- Login screen ----
  if (!authenticated) {
    return (
      <main className="min-h-screen bg-stone-950 flex items-center justify-center">
        <div className="bg-stone-900 border border-stone-800 rounded p-8 w-full max-w-sm">
          <h1 className="font-mono text-amber-400 text-xl mb-6 text-center">
            UCF ADMIN
          </h1>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="Admin secret..."
            className="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 font-mono text-sm text-stone-200 placeholder-stone-600 focus:outline-none focus:border-amber-500 mb-4"
          />
          {authError && (
            <p className="text-red-400 font-mono text-xs mb-3">{authError}</p>
          )}
          <button
            onClick={handleLogin}
            className="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-mono text-sm font-bold py-2 rounded transition-colors"
          >
            AUTHENTICATE
          </button>
        </div>
      </main>
    );
  }

  const stats = dashboard?.stats;
  const q = dashboard?.queue ?? [];
  const activeRumbles = dashboard?.activeRumbles ?? [];
  const recentRumbles = dashboard?.recentRumbles ?? [];
  const fighters = dashboard?.fighters ?? [];
  const shower = dashboard?.ichorShower;
  const allRumbles = [...activeRumbles, ...recentRumbles];

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "rumbles", label: "Rumbles" },
    { id: "fighters", label: "Fighters" },
    { id: "onchain", label: "On-Chain" },
  ];

  return (
    <main className="min-h-screen bg-stone-950 text-stone-200">
      {/* Header */}
      <header className="border-b border-stone-800 bg-stone-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-amber-500 hover:text-amber-400 font-mono text-sm"
            >
              &lt; UCF
            </Link>
            <h1 className="font-mono text-amber-400 text-lg">ADMIN PANEL</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-stone-600">
              {dashboard?.timestamp
                ? `Updated ${new Date(dashboard.timestamp).toLocaleTimeString()}`
                : "Loading..."}
            </span>
            <button
              onClick={() => {
                sessionStorage.removeItem("ucf_admin_secret");
                setAuthenticated(false);
                setDashboard(null);
                setOnChain(null);
              }}
              className="font-mono text-xs text-stone-500 hover:text-red-400 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-stone-800 bg-stone-950/80">
        <div className="max-w-7xl mx-auto px-4 flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 font-mono text-xs border-b-2 transition-colors ${
                tab === t.id
                  ? "border-amber-500 text-amber-400"
                  : "border-transparent text-stone-500 hover:text-stone-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {tab === "overview" && (
          <OverviewTab
            stats={stats}
            queue={q}
            shower={shower}
            activeRumbles={activeRumbles}
            recentRumbles={recentRumbles}
          />
        )}
        {tab === "rumbles" && <RumblesTab rumbles={allRumbles} />}
        {tab === "fighters" && <FightersTab fighters={fighters} />}
        {tab === "onchain" && <OnChainTab data={onChain} />}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab
// ---------------------------------------------------------------------------

function OverviewTab({
  stats,
  queue,
  shower,
  activeRumbles,
  recentRumbles,
}: {
  stats: Stats | null;
  queue: QueueEntry[];
  shower: IchorShower | null;
  activeRumbles: Rumble[];
  recentRumbles: Rumble[];
}) {
  const activeSlots = activeRumbles.filter((r) =>
    ["betting", "combat", "payout"].includes(r.status),
  ).length;

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Queue" value={queue.length} />
        <StatCard label="Active Slots" value={activeSlots} />
        <StatCard label="Total Rumbles" value={stats?.total_rumbles ?? 0} />
        <StatCard
          label="ICHOR Minted"
          value={formatIchor(stats?.total_ichor_minted ?? 0)}
        />
        <StatCard
          label="Shower Pool"
          value={shower?.pool_amount?.toFixed(4) ?? "0"}
        />
        <StatCard
          label="SOL Wagered"
          value={(stats?.total_sol_wagered ?? 0).toFixed(4)}
        />
      </div>

      {/* Active Slots */}
      <Section title="Active Slots">
        {activeRumbles.length === 0 ? (
          <p className="font-mono text-sm text-stone-600">
            No active rumbles right now
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {activeRumbles.map((r) => (
              <div
                key={r.id}
                className="bg-stone-900/60 border border-stone-800 rounded p-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs text-stone-500">
                    Slot {r.slot_index}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <p className="font-mono text-[10px] text-stone-600 mb-2">
                  {r.id}
                </p>
                <p className="font-mono text-xs text-stone-400 mb-2">
                  {Array.isArray(r.fighters) ? r.fighters.length : 0} fighters
                </p>
                <p className="font-mono text-[10px] text-stone-600">
                  Started {formatTime(r.started_at ?? r.created_at)}
                </p>
                <div className="mt-3">
                  <PipelineView txSigs={r.tx_signatures} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Queue */}
      <Section title={`Queue (${queue.length})`}>
        {queue.length === 0 ? (
          <p className="font-mono text-sm text-stone-600">Queue is empty</p>
        ) : (
          <div className="grid gap-1">
            {queue.map((entry, i) => (
              <div
                key={entry.fighter_id}
                className="flex items-center justify-between bg-stone-900/40 border border-stone-800/50 rounded px-3 py-1.5"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-stone-600 w-6">
                    #{i + 1}
                  </span>
                  <span className="font-mono text-sm text-stone-300">
                    {entry.fighter_id}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {entry.auto_requeue && (
                    <span className="font-mono text-[10px] text-amber-500">
                      AUTO
                    </span>
                  )}
                  <StatusBadge status={entry.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Recent Rumbles */}
      <Section title="Recent Rumbles">
        {recentRumbles.length === 0 ? (
          <p className="font-mono text-sm text-stone-600">No completed rumbles yet</p>
        ) : (
          <div className="space-y-2">
            {recentRumbles.slice(0, 5).map((r) => (
              <div
                key={r.id}
                className="bg-stone-900/40 border border-stone-800/50 rounded p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-stone-400">
                      {r.id}
                    </span>
                    <StatusBadge status={r.status} />
                  </div>
                  <span className="font-mono text-[10px] text-stone-600">
                    {formatTime(r.completed_at)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono text-stone-500">
                  <span>
                    Winner:{" "}
                    <span className="text-amber-400">
                      {r.winner_id ?? "N/A"}
                    </span>
                  </span>
                  <span>{r.total_turns ?? 0} turns</span>
                  <span>
                    {Array.isArray(r.fighters) ? r.fighters.length : 0} fighters
                  </span>
                </div>
                <div className="mt-2">
                  <PipelineView txSigs={r.tx_signatures} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rumbles Tab
// ---------------------------------------------------------------------------

function RumblesTab({ rumbles }: { rumbles: Rumble[] }) {
  return (
    <Section title={`All Rumbles (${rumbles.length})`}>
      {rumbles.length === 0 ? (
        <p className="font-mono text-sm text-stone-600">No rumbles found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-stone-500 border-b border-stone-800">
                <th className="text-left py-2 px-2">ID</th>
                <th className="text-left py-2 px-2">Slot</th>
                <th className="text-left py-2 px-2">Status</th>
                <th className="text-left py-2 px-2">Fighters</th>
                <th className="text-left py-2 px-2">Winner</th>
                <th className="text-left py-2 px-2">Turns</th>
                <th className="text-left py-2 px-2">Created</th>
                <th className="text-left py-2 px-2">Pipeline</th>
              </tr>
            </thead>
            <tbody>
              {rumbles.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-stone-800/50 hover:bg-stone-900/40"
                >
                  <td className="py-2 px-2 text-stone-400">{r.id}</td>
                  <td className="py-2 px-2">{r.slot_index}</td>
                  <td className="py-2 px-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="py-2 px-2">
                    {Array.isArray(r.fighters) ? r.fighters.length : 0}
                  </td>
                  <td className="py-2 px-2 text-amber-400">
                    {r.winner_id ?? "-"}
                  </td>
                  <td className="py-2 px-2">{r.total_turns ?? "-"}</td>
                  <td className="py-2 px-2 text-stone-500">
                    {formatTime(r.created_at)}
                  </td>
                  <td className="py-2 px-2">
                    <PipelineView txSigs={r.tx_signatures} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Fighters Tab
// ---------------------------------------------------------------------------

function FightersTab({ fighters }: { fighters: Fighter[] }) {
  return (
    <Section title={`Fighters (${fighters.length})`}>
      {fighters.length === 0 ? (
        <p className="font-mono text-sm text-stone-600">No fighters found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr className="text-stone-500 border-b border-stone-800">
                <th className="text-left py-2 px-2">Name</th>
                <th className="text-left py-2 px-2">Wallet</th>
                <th className="text-right py-2 px-2">W</th>
                <th className="text-right py-2 px-2">L</th>
                <th className="text-right py-2 px-2">D</th>
                <th className="text-right py-2 px-2">Played</th>
                <th className="text-right py-2 px-2">Points</th>
                <th className="text-left py-2 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {fighters.map((f) => (
                <tr
                  key={f.id}
                  className="border-b border-stone-800/50 hover:bg-stone-900/40"
                >
                  <td className="py-2 px-2 text-amber-400">{f.name}</td>
                  <td className="py-2 px-2 text-stone-500">
                    {f.wallet_address ? truncate(f.wallet_address) : "-"}
                  </td>
                  <td className="py-2 px-2 text-right text-green-400">
                    {f.wins}
                  </td>
                  <td className="py-2 px-2 text-right text-red-400">
                    {f.losses}
                  </td>
                  <td className="py-2 px-2 text-right text-stone-400">
                    {f.draws}
                  </td>
                  <td className="py-2 px-2 text-right">{f.matches_played}</td>
                  <td className="py-2 px-2 text-right">{f.points}</td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1">
                      {f.verified && (
                        <span className="text-green-500 text-[10px]">
                          VERIFIED
                        </span>
                      )}
                      {f.is_active ? (
                        <span className="text-green-600 text-[10px]">
                          ACTIVE
                        </span>
                      ) : (
                        <span className="text-stone-600 text-[10px]">
                          INACTIVE
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// On-Chain Tab
// ---------------------------------------------------------------------------

function OnChainTab({ data }: { data: OnChainData | null }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="font-mono text-stone-600 animate-pulse">
          Loading on-chain state...
        </p>
      </div>
    );
  }

  const arena = data.arenaConfig;
  const rumble = data.rumbleConfig;
  const registry = data.registryConfig;

  return (
    <div className="space-y-6">
      {/* Arena Config (ICHOR Token Program) */}
      <Section title="Arena Config (ICHOR Token)">
        {arena ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <OnChainField
              label="Total Minted"
              value={formatIchor(arena.totalMinted)}
              unit="ICHOR"
            />
            <OnChainField
              label="Rumbles Completed"
              value={arena.totalRumblesCompleted}
            />
            <OnChainField
              label="Base Reward"
              value={formatIchor(arena.baseReward)}
              unit="ICHOR"
            />
            <OnChainField
              label="Shower Pool"
              value={formatIchor(arena.ichorShowerPool)}
              unit="ICHOR"
            />
            <OnChainField
              label="Treasury Vault"
              value={formatIchor(arena.treasuryVault)}
              unit="ICHOR"
            />
            <OnChainField
              label="Admin"
              value={truncate(arena.admin)}
              title={arena.admin}
            />
            <OnChainField
              label="ICHOR Mint"
              value={truncate(arena.ichorMint)}
              title={arena.ichorMint}
            />
            <OnChainField label="Bump" value={arena.bump} />
          </div>
        ) : (
          <p className="font-mono text-sm text-red-400">
            Could not read ArenaConfig from chain
          </p>
        )}
      </Section>

      {/* Rumble Config (Rumble Engine Program) */}
      <Section title="Rumble Config (Rumble Engine)">
        {rumble ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <OnChainField label="Total Rumbles" value={rumble.totalRumbles} />
            <OnChainField
              label="Admin"
              value={truncate(rumble.admin)}
              title={rumble.admin}
            />
            <OnChainField
              label="Treasury"
              value={truncate(rumble.treasury)}
              title={rumble.treasury}
            />
            <OnChainField label="Bump" value={rumble.bump} />
          </div>
        ) : (
          <p className="font-mono text-sm text-red-400">
            Could not read RumbleConfig from chain
          </p>
        )}
      </Section>

      {/* Registry Config (Fighter Registry Program) */}
      <Section title="Registry Config (Fighter Registry)">
        {registry ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <OnChainField
              label="Total Fighters"
              value={registry.totalFighters}
            />
            <OnChainField
              label="Admin"
              value={truncate(registry.admin)}
              title={registry.admin}
            />
            <OnChainField label="Bump" value={registry.bump} />
          </div>
        ) : (
          <p className="font-mono text-sm text-red-400">
            Could not read RegistryConfig from chain
          </p>
        )}
      </Section>

      <p className="font-mono text-[10px] text-stone-600 text-right">
        Last fetched: {data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "-"} //
        polled every 30s
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI Components
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="font-mono text-sm text-amber-400 mb-3 uppercase tracking-wider">
        {title}
      </h2>
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="bg-stone-900/60 border border-stone-800 rounded p-3">
      <p className="font-mono text-[10px] text-stone-500 uppercase mb-1">
        {label}
      </p>
      <p className="font-mono text-lg text-stone-200">{value}</p>
    </div>
  );
}

function OnChainField({
  label,
  value,
  unit,
  title,
}: {
  label: string;
  value: string | number;
  unit?: string;
  title?: string;
}) {
  return (
    <div className="bg-stone-900/40 border border-stone-800/50 rounded p-3">
      <p className="font-mono text-[10px] text-stone-500 uppercase mb-1">
        {label}
      </p>
      <p className="font-mono text-sm text-stone-200" title={title}>
        {value}
        {unit && (
          <span className="text-[10px] text-stone-500 ml-1">{unit}</span>
        )}
      </p>
    </div>
  );
}
