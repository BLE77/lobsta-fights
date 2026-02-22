"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface Fighter {
  id: string;
  name: string;
  description: string | null;
  special_move: string | null;
  image_url: string | null;
  points: number;
  wins: number;
  losses: number;
  draws: number;
  matches_played: number;
  win_streak: number;
  best_win_streak: number;
  win_rate: number;
  rank: number | null;
  verified: boolean;
  robot_metadata: {
    chassis_description?: string;
    fists_description?: string;
    color_scheme?: string;
    distinguishing_features?: string;
    fighting_style?: string;
    personality?: string;
  } | null;
  created_at: string;
}

interface Match {
  id: string;
  state: string;
  winner_id: string | null;
  points_wager: number;
  result_image_url: string | null;
  created_at: string;
  finished_at: string | null;
  fighter_a: { id: string; name: string; image_url: string | null };
  fighter_b: { id: string; name: string; image_url: string | null };
}

export default function FighterProfile() {
  const params = useParams();
  const fighterId = params.id as string;

  const [fighter, setFighter] = useState<Fighter | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [selectedRival, setSelectedRival] = useState<string | null>(null);
  const [h2hData, setH2hData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fighterId) {
      setSelectedRival(null);
      fetchFighter();
      fetchStats();
    }
  }, [fighterId]);

  useEffect(() => {
    if (selectedRival && fighterId) {
      fetchH2H(selectedRival);
    }
  }, [selectedRival, fighterId]);

  const fetchFighter = async () => {
    try {
      const res = await fetch(`/api/fighter/${fighterId}`);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Fighter not found");
        return;
      }

      setFighter(data.fighter);
      setMatches(data.matches || []);
    } catch (e: any) {
      setError(e.message || "Failed to load fighter");
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`/api/fighter/${fighterId}/stats`);
      const data = await res.json();
      if (res.ok) setStats(data);
    } catch (e) {
      console.error("Failed to fetch stats:", e);
    }
  };

  const fetchH2H = async (opponentId: string) => {
    try {
      const res = await fetch(`/api/fighter/${fighterId}/stats?opponent_id=${opponentId}`);
      const data = await res.json();
      if (res.ok) setH2hData(data.head_to_head);
    } catch (e) {
      console.error("Failed to fetch H2H:", e);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-stone-950 via-stone-900 to-stone-950 text-stone-200 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="text-amber-600 text-2xl font-mono animate-pulse text-center">
            Loading Fighter...
          </div>
        </div>
      </main>
    );
  }

  if (error || !fighter) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-stone-950 via-stone-900 to-stone-950 text-stone-200 p-8">
        <div className="max-w-4xl mx-auto text-center">
          <div className="text-red-500 text-2xl font-mono mb-4">
            {error || "Fighter not found"}
          </div>
          <Link href="/" className="text-amber-500 hover:text-amber-400 font-mono">
            ← Back to Arena
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-stone-950 via-stone-900 to-stone-950 text-stone-200 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Back Link */}
        <Link
          href="/"
          className="inline-block mb-6 text-amber-500 hover:text-amber-400 font-mono text-sm"
        >
          ← Back to Arena
        </Link>

        {/* Fighter Header */}
        <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-6 mb-6">
          <div className="flex flex-col md:flex-row gap-6">
            {/* Profile Image */}
            <div className="flex-shrink-0">
              {fighter.image_url ? (
                <img
                  src={fighter.image_url}
                  alt={fighter.name}
                  className="w-48 h-48 md:w-64 md:h-64 rounded-sm object-cover border-2 border-amber-600/50 mx-auto"
                />
              ) : (
                <div className="w-48 h-48 md:w-64 md:h-64 rounded-sm bg-stone-800 flex items-center justify-center border-2 border-stone-600 mx-auto">
                  <span className="text-stone-500 font-mono text-4xl">BOT</span>
                </div>
              )}
            </div>

            {/* Fighter Info */}
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2">
                {fighter.rank && (
                  <span className="text-amber-500 font-mono text-xl">#{fighter.rank}</span>
                )}
                <h1 className="text-3xl md:text-4xl font-bold text-amber-400 font-mono">
                  {fighter.name}
                </h1>
              </div>

              {fighter.verified && (
                <span className="inline-block px-2 py-1 bg-green-900/50 border border-green-700 text-green-400 text-xs font-mono mb-4">
                  VERIFIED
                </span>
              )}

              {/* Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                  <div className="text-2xl font-bold text-amber-500 font-mono">
                    {fighter.points.toLocaleString()}
                  </div>
                  <div className="text-xs text-stone-500 uppercase">Points</div>
                </div>
                <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                  <div className="text-2xl font-bold text-green-500 font-mono">
                    {fighter.wins}
                  </div>
                  <div className="text-xs text-stone-500 uppercase">Wins</div>
                </div>
                <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                  <div className="text-2xl font-bold text-red-500 font-mono">
                    {fighter.losses}
                  </div>
                  <div className="text-xs text-stone-500 uppercase">Losses</div>
                </div>
                <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                  <div className="text-2xl font-bold text-stone-300 font-mono">
                    {fighter.win_rate}%
                  </div>
                  <div className="text-xs text-stone-500 uppercase">Win Rate</div>
                </div>
              </div>

              {/* Additional Stats */}
              <div className="flex gap-4 mt-4 text-sm font-mono">
                <div>
                  <span className="text-stone-500">Matches:</span>{" "}
                  <span className="text-stone-300">{fighter.matches_played}</span>
                </div>
                <div>
                  <span className="text-stone-500">Win Streak:</span>{" "}
                  <span className="text-amber-400">{fighter.win_streak}</span>
                </div>
                <div>
                  <span className="text-stone-500">Best Streak:</span>{" "}
                  <span className="text-amber-400">{fighter.best_win_streak}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Fighter Details */}
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Description */}
          {fighter.description && (
            <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-4">
              <h2 className="text-amber-500 font-mono text-sm uppercase mb-2">Description</h2>
              <p className="text-stone-300 text-sm">{fighter.description}</p>
            </div>
          )}

          {/* Special Move */}
          {fighter.special_move && (
            <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-4">
              <h2 className="text-red-500 font-mono text-sm uppercase mb-2">Special Move</h2>
              <p className="text-stone-300 text-sm">{fighter.special_move}</p>
            </div>
          )}

          {/* Robot Metadata */}
          {fighter.robot_metadata?.fighting_style && (
            <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-4">
              <h2 className="text-amber-500 font-mono text-sm uppercase mb-2">Fighting Style</h2>
              <p className="text-stone-300 text-sm capitalize">{fighter.robot_metadata.fighting_style}</p>
            </div>
          )}

          {fighter.robot_metadata?.personality && (
            <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-4">
              <h2 className="text-amber-500 font-mono text-sm uppercase mb-2">Personality</h2>
              <p className="text-stone-300 text-sm">{fighter.robot_metadata.personality}</p>
            </div>
          )}
        </div>

        {/* Move Analytics */}
        {stats?.move_analytics && (
          <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-6 mb-6">
            <h2 className="text-amber-500 font-mono text-lg mb-4">// COMBAT ANALYTICS</h2>

            {/* Category Breakdown */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-red-400 font-mono">{stats.move_analytics.strike_frequency}%</div>
                <div className="text-[10px] text-stone-500 uppercase">Strikes</div>
              </div>
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-blue-400 font-mono">{stats.move_analytics.guard_frequency}%</div>
                <div className="text-[10px] text-stone-500 uppercase">Guards</div>
              </div>
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-green-400 font-mono">{stats.move_analytics.dodge_frequency}%</div>
                <div className="text-[10px] text-stone-500 uppercase">Dodges</div>
              </div>
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-yellow-400 font-mono">{stats.move_analytics.catch_frequency}%</div>
                <div className="text-[10px] text-stone-500 uppercase">Catches</div>
              </div>
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-purple-400 font-mono">{stats.move_analytics.special_frequency}%</div>
                <div className="text-[10px] text-stone-500 uppercase">Specials</div>
              </div>
            </div>

            {/* Move Distribution Bars */}
            <div className="space-y-2 mb-6">
              {Object.entries(stats.move_analytics.move_distribution as Record<string, { count: number; percentage: number }>).map(([move, data]) => {
                const isFav = move === stats.move_analytics.favorite_move;
                const barColor = move.includes("STRIKE") ? "bg-red-500" :
                  move.includes("GUARD") ? "bg-blue-500" :
                  move === "DODGE" ? "bg-green-500" :
                  move === "CATCH" ? "bg-yellow-500" : "bg-purple-500";

                return (
                  <div key={move} className="flex items-center gap-3">
                    <div className={`w-28 text-xs font-mono truncate ${isFav ? "text-amber-400 font-bold" : "text-stone-400"}`}>
                      {isFav && "* "}{move.replace("_", " ")}
                    </div>
                    <div className="flex-1 h-4 bg-stone-800 rounded-sm overflow-hidden">
                      <div
                        className={`h-full ${barColor} transition-all`}
                        style={{ width: `${Math.max(data.percentage, 1)}%` }}
                      />
                    </div>
                    <div className="w-16 text-right text-xs font-mono text-stone-500">
                      {data.count} ({data.percentage}%)
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Damage Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-amber-500 font-mono">{stats.move_analytics.avg_damage_dealt}</div>
                <div className="text-[10px] text-stone-500 uppercase">Avg Dmg Dealt/Turn</div>
              </div>
              <div className="bg-stone-800/50 p-3 rounded-sm text-center">
                <div className="text-xl font-bold text-stone-400 font-mono">{stats.move_analytics.avg_damage_taken}</div>
                <div className="text-[10px] text-stone-500 uppercase">Avg Dmg Taken/Turn</div>
              </div>
            </div>
          </div>
        )}

        {/* Top Rivals */}
        {stats?.top_rivals && stats.top_rivals.length > 0 && (
          <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-6 mb-6">
            <h2 className="text-amber-500 font-mono text-lg mb-4">// TOP RIVALS</h2>

            <div className="space-y-2">
              {stats.top_rivals.map((rival: any) => (
                <button
                  key={rival.opponent_id}
                  onClick={() => setSelectedRival(selectedRival === rival.opponent_id ? null : rival.opponent_id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-sm border transition-all text-left ${
                    selectedRival === rival.opponent_id
                      ? "bg-amber-900/20 border-amber-700/50"
                      : "bg-stone-800/30 border-stone-700/30 hover:bg-stone-800/50"
                  }`}
                >
                  {rival.opponent_image_url ? (
                    <img src={rival.opponent_image_url} alt={rival.opponent_name} className="w-10 h-10 rounded-sm object-cover border border-stone-600" />
                  ) : (
                    <div className="w-10 h-10 rounded-sm bg-stone-700 flex items-center justify-center border border-stone-600">
                      <span className="text-stone-500 text-xs font-mono">BOT</span>
                    </div>
                  )}
                  <div className="flex-1">
                    <p className="font-mono font-bold text-stone-200 text-sm">{rival.opponent_name}</p>
                    <p className="text-xs text-stone-500 font-mono">{rival.total} matches</p>
                  </div>
                  <div className="text-right font-mono text-sm">
                    <span className="text-green-400">{rival.wins}W</span>
                    <span className="text-stone-600 mx-1">-</span>
                    <span className="text-red-400">{rival.losses}L</span>
                  </div>
                </button>
              ))}
            </div>

            {/* Head-to-Head Detail */}
            {selectedRival && h2hData && (
              <div className="mt-4 p-4 bg-stone-950/80 border border-amber-700/30 rounded-sm">
                <div className="text-center mb-3">
                  <span className="text-amber-400 font-mono font-bold text-lg">
                    {fighter.name} vs {h2hData.opponent_name}
                  </span>
                  <div className="text-2xl font-mono font-bold mt-1">
                    <span className="text-green-400">{h2hData.wins}</span>
                    <span className="text-stone-600 mx-2">-</span>
                    <span className="text-red-400">{h2hData.losses}</span>
                  </div>
                </div>
                {h2hData.matches && h2hData.matches.length > 0 && (
                  <div className="space-y-1">
                    {h2hData.matches.map((m: any) => (
                      <Link
                        key={m.id}
                        href={`/matches/${m.id}`}
                        className="flex items-center justify-between p-2 bg-stone-800/30 hover:bg-stone-800/50 rounded-sm text-xs font-mono transition-all"
                      >
                        <span className={m.winner_id === fighterId ? "text-green-400" : m.winner_id ? "text-red-400" : "text-stone-400"}>
                          {m.winner_id === fighterId ? "WIN" : m.winner_id ? "LOSS" : "DRAW"}
                        </span>
                        <span className="text-stone-500">
                          {m.finished_at ? new Date(m.finished_at).toLocaleDateString() : "N/A"}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Match History */}
        <div className="bg-stone-900/80 border border-stone-700 rounded-sm p-6">
          <h2 className="text-amber-500 font-mono text-lg mb-4">// MATCH HISTORY</h2>

          {matches.length === 0 ? (
            <p className="text-stone-500 font-mono text-center py-8">
              No matches yet. This fighter is waiting for their first battle!
            </p>
          ) : (
            <div className="space-y-3">
              {matches.map((match) => {
                const isWinner = match.winner_id === fighter.id;
                const isDraw = match.winner_id === null;
                const opponent =
                  match.fighter_a.id === fighter.id ? match.fighter_b : match.fighter_a;

                return (
                  <Link
                    key={match.id}
                    href={`/matches/${match.id}`}
                    className={`flex items-center gap-4 p-3 rounded-sm border transition-all hover:bg-stone-800/50 ${
                      isDraw
                        ? "bg-stone-800/20 border-stone-700/50"
                        : isWinner
                          ? "bg-green-900/20 border-green-800/50"
                          : "bg-red-900/20 border-red-800/50"
                    }`}
                  >
                    {/* Result Badge */}
                    <div
                      className={`w-16 text-center font-mono font-bold text-sm py-1 rounded-sm ${
                        isDraw
                          ? "bg-stone-600 text-white"
                          : isWinner
                            ? "bg-green-600 text-white"
                            : "bg-red-600 text-white"
                      }`}
                    >
                      {isDraw ? "DRAW" : isWinner ? "WIN" : "LOSS"}
                    </div>

                    {/* Opponent */}
                    <div className="flex items-center gap-2 flex-1">
                      <span className="text-stone-500 text-sm">vs</span>
                      {opponent.image_url ? (
                        <img
                          src={opponent.image_url}
                          alt={opponent.name}
                          className="w-8 h-8 rounded-sm object-cover border border-stone-600"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-sm bg-stone-700 flex items-center justify-center">
                          <span className="text-stone-500 text-xs">?</span>
                        </div>
                      )}
                      <span className="font-mono text-stone-200">{opponent.name}</span>
                    </div>

                    {/* Points */}
                    <div className="text-right">
                      <div
                        className={`font-mono font-bold ${
                          isDraw
                            ? "text-stone-400"
                            : isWinner
                              ? "text-green-400"
                              : "text-red-400"
                        }`}
                      >
                        {isDraw ? "0" : `${isWinner ? "+" : "-"}${match.points_wager || 100}`}
                      </div>
                      <div className="text-xs text-stone-600">points</div>
                    </div>

                    {/* Date */}
                    <div className="text-stone-500 text-xs font-mono hidden md:block">
                      {match.finished_at ? new Date(match.finished_at).toLocaleDateString() : "N/A"}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Joined Date */}
        <div className="text-center mt-6 text-stone-600 text-xs font-mono">
          Joined: {new Date(fighter.created_at).toLocaleDateString()}
        </div>
      </div>
    </main>
  );
}
