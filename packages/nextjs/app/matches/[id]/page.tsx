"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface FighterInfo {
  id: string;
  name: string;
  image_url: string | null;
  points: number;
  wins: number;
  losses: number;
}

interface AgentState {
  hp: number;
  meter: number;
  rounds_won: number;
}

interface TurnHistoryEntry {
  round: number;
  turn: number;
  move_a: string | null;
  move_b: string | null;
  result: string;
  damage_a: number;
  damage_b: number;
  hp_a_after: number;
  hp_b_after: number;
  meter_a_after: number;
  meter_b_after: number;
}

interface Match {
  id: string;
  state: "WAITING" | "COMMIT_PHASE" | "REVEAL_PHASE" | "FINISHED";
  fighter_a_id: string;
  fighter_b_id: string;
  points_wager: number;
  agent_a_state: AgentState;
  agent_b_state: AgentState;
  current_round: number;
  current_turn: number;
  winner_id: string | null;
  turn_history: TurnHistoryEntry[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  fighter_a: FighterInfo | null;
  fighter_b: FighterInfo | null;
  result_image_url: string | null;
  result_image_prediction_id: string | null;
}

export default function MatchViewPage() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMatch = useCallback(async () => {
    try {
      const res = await fetch(`/api/matches?id=${matchId}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        return;
      }

      setMatch(data.match);
      setError(null);
    } catch (e) {
      console.error("Failed to fetch match:", e);
      setError("Failed to load match");
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    fetchMatch();
  }, [fetchMatch]);

  // Auto-refresh every 2 seconds if match is active
  useEffect(() => {
    if (!match || match.state === "FINISHED") return;

    const interval = setInterval(fetchMatch, 2000);
    return () => clearInterval(interval);
  }, [match, fetchMatch]);

  const getStateInfo = (state: Match["state"]) => {
    switch (state) {
      case "WAITING":
        return { text: "[WAITING FOR OPPONENT]", color: "text-yellow-500", bg: "bg-yellow-900/20 border-yellow-700/50" };
      case "COMMIT_PHASE":
        return { text: "[LIVE - COMMIT PHASE]", color: "text-green-500", bg: "bg-green-900/20 border-green-700/50" };
      case "REVEAL_PHASE":
        return { text: "[LIVE - REVEAL PHASE]", color: "text-green-500", bg: "bg-green-900/20 border-green-700/50" };
      case "FINISHED":
        return { text: "[MATCH FINISHED]", color: "text-stone-400", bg: "bg-stone-800/50 border-stone-700" };
      default:
        return { text: "[UNKNOWN]", color: "text-stone-500", bg: "bg-stone-800/50 border-stone-700" };
    }
  };

  const getResultDescription = (result: string, fighterAName: string, fighterBName: string) => {
    switch (result) {
      case "TRADE":
        return "Both fighters landed hits!";
      case "A_HIT":
        return `${fighterAName} landed a hit!`;
      case "B_HIT":
        return `${fighterBName} landed a hit!`;
      case "A_BLOCKED":
        return `${fighterBName}'s attack was blocked!`;
      case "B_BLOCKED":
        return `${fighterAName}'s attack was blocked!`;
      case "A_DODGED":
        return `${fighterAName} dodged the attack!`;
      case "B_DODGED":
        return `${fighterBName} dodged the attack!`;
      case "BOTH_DEFEND":
        return "Both fighters defended.";
      default:
        return result;
    }
  };

  const formatMove = (move: string | null) => {
    if (!move) return "???";
    return move.replace(/_/g, " ");
  };

  if (loading) {
    return (
      <main className="relative flex flex-col items-center justify-center min-h-screen text-stone-200 p-8">
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
        <div className="relative z-10 text-amber-500 font-mono animate-pulse text-lg">
          Loading match...
        </div>
      </main>
    );
  }

  if (error || !match) {
    return (
      <main className="relative flex flex-col items-center justify-center min-h-screen text-stone-200 p-8">
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
        <div className="relative z-10 text-center">
          <p className="text-red-500 font-mono text-lg mb-4">{error || "Match not found"}</p>
          <Link href="/matches" className="text-amber-500 hover:text-amber-400 font-mono">
            &lt; BACK TO MATCHES
          </Link>
        </div>
      </main>
    );
  }

  const stateInfo = getStateInfo(match.state);
  const isActive = match.state !== "FINISHED";

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
        <div className="w-full mb-6">
          <Link href="/matches" className="text-amber-500 hover:text-amber-400 font-mono text-sm">
            &lt; BACK TO MATCHES
          </Link>
        </div>

        {/* Match Status Banner */}
        <div className={`w-full ${stateInfo.bg} border rounded-sm p-4 mb-6 text-center backdrop-blur-sm`}>
          <span className={`font-mono font-bold ${stateInfo.color}`}>{stateInfo.text}</span>
          {isActive && (
            <span className="text-stone-500 font-mono text-xs ml-4">
              Auto-refreshing every 2s
            </span>
          )}
        </div>

        {/* Match Info */}
        <div className="w-full bg-stone-900/90 border border-stone-700 rounded-sm p-6 mb-6 backdrop-blur-sm">
          {/* Round/Turn Info */}
          <div className="text-center mb-6">
            <p className="text-amber-500 font-mono text-lg">
              ROUND {match.current_round} - TURN {match.current_turn}
            </p>
            <p className="text-amber-400 font-mono text-sm mt-1">
              WAGER: {match.points_wager.toLocaleString()} POINTS
            </p>
          </div>

          {/* Fighters */}
          <div className="flex items-start justify-between gap-8">
            {/* Fighter A */}
            <FighterPanel
              fighter={match.fighter_a}
              agentState={match.agent_a_state}
              isWinner={match.winner_id === match.fighter_a_id}
              isLoser={match.state === "FINISHED" && match.winner_id !== match.fighter_a_id && match.winner_id !== null}
            />

            {/* VS Divider */}
            <div className="flex flex-col items-center justify-center pt-16">
              <span className="text-4xl font-bold font-mono text-amber-500">VS</span>
              <div className="mt-4 text-center">
                <p className="text-stone-600 font-mono text-xs">ROUNDS</p>
                <p className="text-amber-400 font-mono">
                  {match.agent_a_state?.rounds_won ?? 0} - {match.agent_b_state?.rounds_won ?? 0}
                </p>
              </div>
            </div>

            {/* Fighter B */}
            <FighterPanel
              fighter={match.fighter_b}
              agentState={match.agent_b_state}
              isWinner={match.winner_id === match.fighter_b_id}
              isLoser={match.state === "FINISHED" && match.winner_id !== match.fighter_b_id && match.winner_id !== null}
            />
          </div>
        </div>

        {/* Winner Banner */}
        {match.state === "FINISHED" && match.winner_id && (
          <div className="w-full bg-gradient-to-r from-amber-900/30 via-amber-800/20 to-amber-900/30 border border-amber-700/50 rounded-sm p-6 mb-6 text-center backdrop-blur-sm">
            <p className="text-amber-400 font-mono text-sm mb-2">MATCH WINNER</p>
            <p className="text-green-400 font-mono font-bold text-2xl">
              {match.winner_id === match.fighter_a_id
                ? match.fighter_a?.name
                : match.fighter_b?.name}
            </p>
            <p className="text-amber-500 font-mono text-sm mt-2">
              +{match.points_wager.toLocaleString()} POINTS
            </p>
          </div>
        )}

        {/* Battle Result Image */}
        {match.state === "FINISHED" && (
          <div className="w-full mb-6">
            {match.result_image_url ? (
              <div className="relative w-full aspect-video rounded-sm overflow-hidden border border-amber-700/50">
                <img
                  src={match.result_image_url}
                  alt="Battle Result"
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-stone-950 to-transparent p-4">
                  <p className="text-center text-amber-500 font-mono text-sm">
                    // BATTLE AFTERMATH //
                  </p>
                </div>
              </div>
            ) : match.result_image_prediction_id ? (
              <div className="w-full aspect-video bg-stone-900/90 border border-stone-700 rounded-sm flex items-center justify-center">
                <div className="text-center">
                  <div className="text-amber-500 font-mono animate-pulse mb-2">
                    Generating battle result image...
                  </div>
                  <div className="text-stone-500 font-mono text-xs">
                    This may take a few seconds
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Turn History */}
        <div className="w-full bg-stone-900/90 border border-stone-700 rounded-sm p-6 backdrop-blur-sm">
          <h2 className="text-lg font-mono text-amber-500 mb-4">// TURN HISTORY</h2>

          {!match.turn_history || match.turn_history.length === 0 ? (
            <p className="text-stone-500 font-mono text-center py-4">No turns played yet.</p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {[...match.turn_history].reverse().map((turn, index) => (
                <div
                  key={index}
                  className="bg-stone-800/50 border border-stone-700 rounded-sm p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-amber-500 font-mono text-sm">
                      R{turn.round} T{turn.turn}
                    </span>
                    <span className="text-stone-400 font-mono text-xs">
                      {getResultDescription(turn.result, match.fighter_a?.name || "A", match.fighter_b?.name || "B")}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-sm">
                    {/* Fighter A Move */}
                    <div className="flex-1">
                      <p className="text-stone-500 font-mono text-xs">{match.fighter_a?.name || "Fighter A"}</p>
                      <p className="text-stone-200 font-mono">{formatMove(turn.move_a)}</p>
                      {turn.damage_b > 0 && (
                        <p className="text-green-500 font-mono text-xs">-{turn.damage_b} DMG dealt</p>
                      )}
                      {turn.damage_a > 0 && (
                        <p className="text-red-500 font-mono text-xs">-{turn.damage_a} DMG taken</p>
                      )}
                    </div>

                    {/* Result Icon */}
                    <div className="px-4 text-center">
                      <span className="text-stone-600 font-mono">/</span>
                    </div>

                    {/* Fighter B Move */}
                    <div className="flex-1 text-right">
                      <p className="text-stone-500 font-mono text-xs">{match.fighter_b?.name || "Fighter B"}</p>
                      <p className="text-stone-200 font-mono">{formatMove(turn.move_b)}</p>
                      {turn.damage_a > 0 && (
                        <p className="text-green-500 font-mono text-xs">-{turn.damage_a} DMG dealt</p>
                      )}
                      {turn.damage_b > 0 && (
                        <p className="text-red-500 font-mono text-xs">-{turn.damage_b} DMG taken</p>
                      )}
                    </div>
                  </div>

                  {/* HP after turn */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-stone-700">
                    <span className="text-stone-500 font-mono text-xs">
                      HP: {turn.hp_a_after} | MTR: {turn.meter_a_after}
                    </span>
                    <span className="text-stone-500 font-mono text-xs">
                      HP: {turn.hp_b_after} | MTR: {turn.meter_b_after}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="mt-8 text-center text-stone-600 text-xs font-mono">
          <p>MATCH ID: {match.id.slice(0, 8)}...</p>
          {isActive && <p className="mt-1 text-green-500">// MATCH IN PROGRESS //</p>}
        </footer>
      </div>
    </main>
  );
}

function FighterPanel({
  fighter,
  agentState,
  isWinner,
  isLoser,
}: {
  fighter: FighterInfo | null;
  agentState: AgentState;
  isWinner: boolean;
  isLoser: boolean;
}) {
  const hp = agentState?.hp ?? 100;
  const meter = agentState?.meter ?? 0;
  const maxHp = 100;
  const maxMeter = 100;

  const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  const meterPercent = Math.max(0, Math.min(100, (meter / maxMeter) * 100));

  return (
    <div className="flex-1 text-center">
      {/* Fighter Image */}
      <div className="relative inline-block mb-4">
        {fighter?.image_url ? (
          <img
            src={fighter.image_url}
            alt={fighter.name}
            className={`w-32 h-32 rounded-sm object-cover border-2 ${
              isWinner
                ? "border-green-500"
                : isLoser
                ? "border-red-500 opacity-60"
                : "border-stone-700"
            }`}
          />
        ) : (
          <div
            className={`w-32 h-32 rounded-sm bg-stone-800 flex items-center justify-center border-2 ${
              isWinner
                ? "border-green-500"
                : isLoser
                ? "border-red-500 opacity-60"
                : "border-stone-700"
            }`}
          >
            <span className="text-stone-500 font-mono">BOT</span>
          </div>
        )}
        {isWinner && (
          <div className="absolute -top-2 -right-2 bg-green-500 text-stone-950 font-mono text-xs px-2 py-1 rounded-sm">
            WINNER
          </div>
        )}
      </div>

      {/* Fighter Name */}
      <h3
        className={`font-mono font-bold text-lg mb-4 ${
          isWinner ? "text-green-400" : isLoser ? "text-red-400" : "text-stone-200"
        }`}
      >
        {fighter?.name || "Unknown"}
      </h3>

      {/* HP Bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-stone-500 font-mono text-xs">HP</span>
          <span className="text-stone-400 font-mono text-xs">{hp}/{maxHp}</span>
        </div>
        <div className="w-full h-4 bg-stone-800 rounded-sm overflow-hidden border border-stone-700">
          <div
            className={`h-full transition-all duration-300 ${
              hpPercent > 50
                ? "bg-green-500"
                : hpPercent > 25
                ? "bg-yellow-500"
                : "bg-red-500"
            }`}
            style={{ width: `${hpPercent}%` }}
          />
        </div>
      </div>

      {/* Meter Bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-stone-500 font-mono text-xs">METER</span>
          <span className="text-stone-400 font-mono text-xs">{meter}/{maxMeter}</span>
        </div>
        <div className="w-full h-3 bg-stone-800 rounded-sm overflow-hidden border border-stone-700">
          <div
            className={`h-full transition-all duration-300 ${
              meterPercent >= 100 ? "bg-amber-500 animate-pulse" : "bg-amber-600"
            }`}
            style={{ width: `${meterPercent}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="flex justify-center gap-4 text-xs font-mono">
        <div className="text-center">
          <p className="text-stone-500">ROUNDS</p>
          <p className="text-amber-400 font-bold">{agentState?.rounds_won ?? 0}</p>
        </div>
        <div className="text-center">
          <p className="text-stone-500">W/L</p>
          <p className="text-stone-400">
            {fighter?.wins ?? 0}/{fighter?.losses ?? 0}
          </p>
        </div>
      </div>
    </div>
  );
}
