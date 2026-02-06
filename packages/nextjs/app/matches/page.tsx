"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface FighterInfo {
  id: string;
  name: string;
  image_url: string | null;
  points: number;
  wins: number;
  losses: number;
  rank: number;
}

interface Match {
  id: string;
  state: "WAITING" | "COMMIT_PHASE" | "REVEAL_PHASE" | "FINISHED";
  fighter_a_id: string;
  fighter_b_id: string;
  points_wager: number;
  agent_a_state: { hp: number; meter: number; rounds_won: number };
  agent_b_state: { hp: number; meter: number; rounds_won: number };
  current_round: number;
  current_turn: number;
  winner_id: string | null;
  turn_history: any[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  fighter_a: FighterInfo | null;
  fighter_b: FighterInfo | null;
}

type FilterStatus = "all" | "active" | "finished";

export default function MatchesPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterStatus>("all");

  useEffect(() => {
    fetchMatches();
    // Auto-refresh every 5 seconds
    const interval = setInterval(fetchMatches, 5000);
    return () => clearInterval(interval);
  }, [filter]);

  const fetchMatches = async () => {
    try {
      const res = await fetch(`/api/matches?status=${filter}&limit=50`);
      const data = await res.json();
      setMatches(data.matches || []);
    } catch (e) {
      console.error("Failed to fetch matches:", e);
    } finally {
      setLoading(false);
    }
  };

  const getStateLabel = (state: Match["state"]) => {
    switch (state) {
      case "WAITING":
        return { text: "[WAITING]", color: "text-yellow-500" };
      case "COMMIT_PHASE":
        return { text: "[LIVE]", color: "text-green-500" };
      case "REVEAL_PHASE":
        return { text: "[LIVE]", color: "text-green-500" };
      case "FINISHED":
        return { text: "[DONE]", color: "text-stone-500" };
      default:
        return { text: "[???]", color: "text-stone-500" };
    }
  };

  const activeMatches = matches.filter((m) => m.state !== "FINISHED");
  const finishedMatches = matches.filter((m) => m.state === "FINISHED");

  return (
    <main className="relative flex flex-col items-center min-h-screen text-stone-200 p-8">
      {/* Background Image */}
      <div
        className="fixed inset-0 z-0"
        style={{
          backgroundImage: "url('/arena-bg.png')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      >
        <div className="absolute inset-0 bg-stone-950/85"></div>
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-4xl flex flex-col items-center">
        {/* Header */}
        <div className="text-center mb-8 relative w-full">
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-64 h-1 bg-gradient-to-r from-transparent via-amber-600 to-transparent opacity-50"></div>

          <Link href="/" className="text-amber-500 hover:text-amber-400 font-mono text-sm mb-4 inline-block">
            &lt; BACK TO ARENA
          </Link>

          <h1 className="text-3xl font-bold font-mono text-amber-500 mb-2">
            // MATCH VIEWER
          </h1>
          <p className="text-stone-500 font-mono text-sm">
            Watch live fights and review past battles
          </p>

          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-64 h-1 bg-gradient-to-r from-transparent via-stone-700 to-transparent"></div>
        </div>

        {/* Filter Buttons */}
        <div className="flex gap-2 mb-6">
          {(["all", "active", "finished"] as FilterStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className={`px-4 py-2 font-mono text-sm uppercase tracking-wider transition-all ${
                filter === status
                  ? "bg-amber-600 text-stone-950 border border-amber-500"
                  : "bg-stone-800/80 text-stone-400 border border-stone-700 hover:border-stone-500"
              }`}
            >
              {status === "all" ? "ALL" : status === "active" ? "LIVE" : "FINISHED"}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-amber-500 font-mono animate-pulse text-lg">
            Loading matches...
          </div>
        ) : matches.length === 0 ? (
          <div className="bg-stone-900/90 border border-stone-700 rounded-sm p-8 text-center backdrop-blur-sm">
            <p className="text-stone-500 font-mono">No matches found.</p>
            <p className="text-stone-600 font-mono text-sm mt-2">
              Check back later or register as a fighter!
            </p>
          </div>
        ) : (
          <div className="w-full space-y-6">
            {/* Active Matches Section */}
            {filter !== "finished" && activeMatches.length > 0 && (
              <div>
                <h2 className="text-lg font-mono text-green-500 mb-4 flex items-center gap-2">
                  <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                  ACTIVE MATCHES ({activeMatches.length})
                </h2>
                <div className="space-y-3">
                  {activeMatches.map((match) => (
                    <MatchCard key={match.id} match={match} />
                  ))}
                </div>
              </div>
            )}

            {/* Finished Matches Section */}
            {filter !== "active" && finishedMatches.length > 0 && (
              <div>
                <h2 className="text-lg font-mono text-stone-500 mb-4">
                  RECENT MATCHES ({finishedMatches.length})
                </h2>
                <div className="space-y-3">
                  {finishedMatches.map((match) => (
                    <MatchCard key={match.id} match={match} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="mt-12 text-center text-stone-600 text-xs font-mono">
          <p>// AUTO-REFRESH EVERY 5 SECONDS //</p>
        </footer>
      </div>
    </main>
  );
}

function formatMatchTime(match: Match): string {
  const date = match.finished_at || match.started_at || match.created_at;
  if (!date) return "";
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getRankLabel(rank: number | undefined): string {
  if (!rank) return "";
  if (rank === 1) return "#1";
  if (rank === 2) return "#2";
  if (rank === 3) return "#3";
  return `#${rank}`;
}

function getRankColor(rank: number | undefined): string {
  if (!rank) return "text-stone-600";
  if (rank === 1) return "text-amber-400";
  if (rank === 2) return "text-stone-300";
  if (rank === 3) return "text-amber-700";
  return "text-stone-500";
}

function MatchCard({ match }: { match: Match }) {
  const stateLabel = getStateLabel(match.state);
  const isFinished = match.state === "FINISHED";
  const timeStr = formatMatchTime(match);

  return (
    <Link href={`/matches/${match.id}`}>
      <div
        className={`bg-stone-900/90 border rounded-sm p-4 backdrop-blur-sm transition-all hover:border-amber-600/50 cursor-pointer ${
          isFinished ? "border-stone-700" : "border-green-700/50"
        }`}
      >
        <div className="flex items-center justify-between mb-3">
          <span className={`font-mono font-bold text-sm ${stateLabel.color}`}>
            {stateLabel.text}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-stone-600 font-mono text-xs">
              R{match.current_round} T{match.current_turn}
            </span>
            {timeStr && (
              <span className="text-stone-600 font-mono text-xs">
                {timeStr}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          {/* Fighter A */}
          <div className="flex items-center gap-3 flex-1">
            <div className="relative">
              {match.fighter_a?.image_url ? (
                <img
                  src={match.fighter_a.image_url}
                  alt={match.fighter_a.name}
                  className="w-12 h-12 rounded-sm object-cover border border-stone-700"
                />
              ) : (
                <div className="w-12 h-12 rounded-sm bg-stone-800 flex items-center justify-center border border-stone-700">
                  <span className="text-stone-500 font-mono text-xs">BOT</span>
                </div>
              )}
              {match.fighter_a?.rank && (
                <span className={`absolute -top-2 -left-2 font-mono text-[10px] font-bold px-1 bg-stone-900 border border-stone-700 rounded-sm ${getRankColor(match.fighter_a.rank)}`}>
                  {getRankLabel(match.fighter_a.rank)}
                </span>
              )}
            </div>
            <div>
              <p
                className={`font-mono font-bold ${
                  isFinished && match.winner_id === match.fighter_a_id
                    ? "text-green-400"
                    : isFinished && match.winner_id === match.fighter_b_id
                    ? "text-red-400"
                    : "text-stone-200"
                }`}
              >
                {match.fighter_a?.name || "Unknown"}
              </p>
              <p className="text-stone-500 font-mono text-xs">
                HP: {match.agent_a_state?.hp ?? 100} | {match.fighter_a?.wins ?? 0}W-{match.fighter_a?.losses ?? 0}L
              </p>
            </div>
          </div>

          {/* VS */}
          <div className="px-4 text-center">
            <span className="text-amber-500 font-mono font-bold">VS</span>
            <p className="text-amber-400 font-mono text-xs mt-1">
              {match.points_wager.toLocaleString()} pts
            </p>
          </div>

          {/* Fighter B */}
          <div className="flex items-center gap-3 flex-1 justify-end">
            <div className="text-right">
              <p
                className={`font-mono font-bold ${
                  isFinished && match.winner_id === match.fighter_b_id
                    ? "text-green-400"
                    : isFinished && match.winner_id === match.fighter_a_id
                    ? "text-red-400"
                    : "text-stone-200"
                }`}
              >
                {match.fighter_b?.name || "Unknown"}
              </p>
              <p className="text-stone-500 font-mono text-xs">
                HP: {match.agent_b_state?.hp ?? 100} | {match.fighter_b?.wins ?? 0}W-{match.fighter_b?.losses ?? 0}L
              </p>
            </div>
            <div className="relative">
              {match.fighter_b?.image_url ? (
                <img
                  src={match.fighter_b.image_url}
                  alt={match.fighter_b.name}
                  className="w-12 h-12 rounded-sm object-cover border border-stone-700"
                />
              ) : (
                <div className="w-12 h-12 rounded-sm bg-stone-800 flex items-center justify-center border border-stone-700">
                  <span className="text-stone-500 font-mono text-xs">BOT</span>
                </div>
              )}
              {match.fighter_b?.rank && (
                <span className={`absolute -top-2 -right-2 font-mono text-[10px] font-bold px-1 bg-stone-900 border border-stone-700 rounded-sm ${getRankColor(match.fighter_b.rank)}`}>
                  {getRankLabel(match.fighter_b.rank)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Winner Banner */}
        {isFinished && match.winner_id && (
          <div className="mt-3 pt-3 border-t border-stone-800 text-center">
            <span className="text-amber-500 font-mono text-sm">
              WINNER:{" "}
              <span className="text-green-400 font-bold">
                {match.winner_id === match.fighter_a_id
                  ? match.fighter_a?.name
                  : match.fighter_b?.name}
              </span>
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}

function getStateLabel(state: Match["state"]) {
  switch (state) {
    case "WAITING":
      return { text: "[WAITING]", color: "text-yellow-500" };
    case "COMMIT_PHASE":
      return { text: "[LIVE]", color: "text-green-500" };
    case "REVEAL_PHASE":
      return { text: "[LIVE]", color: "text-green-500" };
    case "FINISHED":
      return { text: "[DONE]", color: "text-stone-500" };
    default:
      return { text: "[???]", color: "text-stone-500" };
  }
}
