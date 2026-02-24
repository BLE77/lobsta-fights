// @ts-nocheck
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { SoundEffect } from "../../../lib/audio";

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
  damage_a?: number;
  damage_b?: number;
  damage_to_a?: number;
  damage_to_b?: number;
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
  commit_deadline: string | null;
  reveal_deadline: string | null;
}

export default function MatchView() {
  const params = useParams();
  const matchId = params.id as string;

  const [match, setMatch] = useState<Match | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showResultImage, setShowResultImage] = useState(false);
  const [lastProgressAt, setLastProgressAt] = useState<number>(Date.now());
  const [lastTurnCount, setLastTurnCount] = useState<number>(0);

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

      // Track progress for stuck detection
      const currentTurnCount = data.match?.turn_history?.length || 0;
      if (currentTurnCount !== lastTurnCount || data.match?.state === "FINISHED") {
        setLastProgressAt(Date.now());
        setLastTurnCount(currentTurnCount);
      }
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

  // Sound effects for new turns
  const prevTurnCountRef = useRef(0);
  const prevMatchState = useRef<string>("");
  const audioRef = useRef<any>(null);

  useEffect(() => {
    import("../../../lib/audio").then((mod) => {
      if (mod.audioManager) {
        audioRef.current = mod.audioManager;
        mod.audioManager.init();
      }
    });
  }, []);

  useEffect(() => {
    if (!match?.turn_history || !audioRef.current) return;
    const audio = audioRef.current;
    const currentCount = match.turn_history.length;

    // Play sound for new turns
    if (currentCount > prevTurnCountRef.current && prevTurnCountRef.current > 0) {
      const latestTurn = match.turn_history[currentCount - 1];
      if (latestTurn) {
        const result = latestTurn.result;
        let sound: SoundEffect = "hit_light";

        if (result === "TRADE") {
          sound = "hit_heavy";
        } else if (result === "A_HIT" || result === "B_HIT") {
          if (latestTurn.move_a === "SPECIAL" || latestTurn.move_b === "SPECIAL") {
            sound = "hit_special";
          } else if ((latestTurn.damage_to_a || 0) >= 18 || (latestTurn.damage_to_b || 0) >= 18) {
            sound = "hit_heavy";
          } else {
            sound = "hit_light";
          }
        } else if (result === "A_BLOCKED" || result === "B_BLOCKED") {
          sound = "block";
        } else if (result === "A_DODGED" || result === "B_DODGED") {
          sound = "dodge";
        } else if (result === "BOTH_DEFEND") {
          sound = "block";
        }

        audio.play(sound);
      }
    }
    prevTurnCountRef.current = currentCount;

    // Play KO sound when match finishes
    if (match.state === "FINISHED" && prevMatchState.current !== "FINISHED") {
      audio.play("ko_explosion");
      setTimeout(() => audio.play("crowd_cheer"), 300);
    }
    prevMatchState.current = match.state;
  }, [match?.turn_history?.length, match?.state]);

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
            backgroundImage: "url('/arena-bg.webp')",
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
            backgroundImage: "url('/arena-bg.webp')",
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
          backgroundImage: "url('/arena-bg.webp')",
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

          {/* Countdown Timer */}
          {isActive && (match.state === "COMMIT_PHASE" || match.state === "REVEAL_PHASE") && (
            <CountdownTimer
              deadline={match.state === "COMMIT_PHASE" ? match.commit_deadline : match.reveal_deadline}
              phase={match.state}
            />
          )}
        </div>

        {/* Stuck Match Warning */}
        {isActive && <StuckMatchWarning lastProgressAt={lastProgressAt} />}

        {/* Match Info */}
        <div className="w-full bg-stone-900/90 border border-stone-700 rounded-sm p-6 mb-6 backdrop-blur-sm">
          {/* Round/Turn Info */}
          <div className="text-center mb-6">
            <p className="font-fight text-amber-500 text-3xl tracking-wider">
              ROUND {match.current_round}
            </p>
            <p className="text-stone-400 font-mono text-sm mt-1">
              TURN {match.current_turn}
            </p>
            <p className="text-amber-400 font-mono text-sm mt-2">
              WAGER: {match.points_wager.toLocaleString()} POINTS
            </p>
          </div>

          {/* DESKTOP: Fighters with Turn History in Middle */}
          <div className="hidden md:flex items-start justify-between gap-4">
            {/* Fighter A */}
            <div className="w-48 flex-shrink-0">
              <FighterPanel
                fighter={match.fighter_a}
                agentState={match.agent_a_state}
                isWinner={match.winner_id === match.fighter_a_id}
                isLoser={match.state === "FINISHED" && match.winner_id !== match.fighter_a_id && match.winner_id !== null}
              />
            </div>

            {/* Turn History - Center Column */}
            <div className="flex-1 min-w-0">
              <div className="text-center mb-3">
                <span className="font-fight-glow text-3xl text-amber-500">VS</span>
                <div className="mt-1">
                  <span className="text-stone-600 font-mono text-xs">ROUNDS: </span>
                  <span className="text-amber-400 font-mono">
                    {match.agent_a_state?.rounds_won ?? 0} - {match.agent_b_state?.rounds_won ?? 0}
                  </span>
                </div>
              </div>

              <TurnHistoryPanel
                turnHistory={match.turn_history}
                formatMove={formatMove}
                maxHeight="max-h-64"
              />
            </div>

            {/* Fighter B */}
            <div className="w-48 flex-shrink-0">
              <FighterPanel
                fighter={match.fighter_b}
                agentState={match.agent_b_state}
                isWinner={match.winner_id === match.fighter_b_id}
                isLoser={match.state === "FINISHED" && match.winner_id !== match.fighter_b_id && match.winner_id !== null}
              />
            </div>
          </div>

          {/* MOBILE: Fighters side by side, Turn History below */}
          <div className="md:hidden">
            {/* Fighters Row */}
            <div className="flex items-start justify-between gap-4 mb-4">
              {/* Fighter A */}
              <FighterPanel
                fighter={match.fighter_a}
                agentState={match.agent_a_state}
                isWinner={match.winner_id === match.fighter_a_id}
                isLoser={match.state === "FINISHED" && match.winner_id !== match.fighter_a_id && match.winner_id !== null}
              />

              {/* VS Divider */}
              <div className="flex flex-col items-center justify-center pt-8">
                <span className="font-fight-glow text-2xl text-amber-500">VS</span>
                <div className="mt-2 text-center">
                  <p className="text-stone-600 font-mono text-[10px]">ROUNDS</p>
                  <p className="text-amber-400 font-mono text-sm">
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

            {/* Turn History Below */}
            <TurnHistoryPanel
              turnHistory={match.turn_history}
              formatMove={formatMove}
              maxHeight="max-h-48"
            />
          </div>
        </div>

        {/* Winner Banner */}
        {match.state === "FINISHED" && match.winner_id && (
          <div className="w-full bg-gradient-to-r from-amber-900/30 via-amber-800/20 to-amber-900/30 border border-amber-700/50 rounded-sm p-6 mb-6 text-center backdrop-blur-sm">
            <p className="font-fight text-amber-400 text-2xl mb-2">WINNER</p>
            <p className="font-fight-glow text-green-400 text-4xl">
              {match.winner_id === match.fighter_a_id
                ? match.fighter_a?.name
                : match.fighter_b?.name}
            </p>
            <p className="text-amber-500 font-mono text-sm mt-3">
              +{match.points_wager.toLocaleString()} POINTS
            </p>
          </div>
        )}

        {/* Battle Result Image - Click to view full */}
        {match.state === "FINISHED" && (
          <div className="w-full mb-6">
            {match.result_image_url ? (
              <>
                {/* Thumbnail - Click to open modal */}
                <button
                  onClick={() => setShowResultImage(true)}
                  className="relative w-full rounded-sm overflow-hidden border-2 border-amber-700/50 bg-stone-900 hover:border-amber-500 transition-all cursor-pointer group"
                >
                  <div className="relative">
                    <img
                      src={match.result_image_url}
                      alt="Battle Result"
                      className="w-full h-auto object-contain group-hover:scale-[1.02] transition-transform duration-300"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-stone-950/80 via-transparent to-transparent" />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="bg-amber-500/90 text-stone-950 px-6 py-3 rounded font-mono font-bold text-lg">
                        CLICK TO VIEW FULL IMAGE
                      </div>
                    </div>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 p-4">
                    <p className="text-center text-amber-500 font-mono text-sm">
                      // BATTLE AFTERMATH - CLICK TO EXPAND //
                    </p>
                  </div>
                </button>

                {/* Full Image Modal */}
                {showResultImage && (
                  <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/95 backdrop-blur-sm"
                    onClick={() => setShowResultImage(false)}
                  >
                    <div className="relative max-w-6xl max-h-[90vh] w-full">
                      {/* Close button */}
                      <button
                        onClick={() => setShowResultImage(false)}
                        className="absolute -top-12 right-0 text-amber-500 hover:text-amber-400 font-mono text-lg z-10"
                      >
                        [X] CLOSE
                      </button>

                      {/* Winner banner */}
                      <div className="absolute -top-12 left-0 text-amber-500 font-fight text-xl">
                        KNOCKOUT VICTORY
                      </div>

                      {/* Image container */}
                      <div className="relative rounded-sm overflow-hidden border-2 border-amber-500 shadow-2xl shadow-amber-500/20">
                        <img
                          src={match.result_image_url}
                          alt="Battle Result - Full"
                          className="w-full h-auto max-h-[85vh] object-contain bg-stone-900"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>

                      {/* Winner info */}
                      <div className="mt-4 text-center">
                        <p className="font-fight-glow text-green-400 text-2xl">
                          {match.winner_id === match.fighter_a_id
                            ? match.fighter_a?.name
                            : match.fighter_b?.name}
                        </p>
                        <p className="text-amber-500 font-mono text-sm mt-1">
                          DEFEATS{" "}
                          {match.winner_id === match.fighter_a_id
                            ? match.fighter_b?.name
                            : match.fighter_a?.name}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </>
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
          <div className="absolute -top-2 -right-2 bg-green-500 text-stone-950 font-fight text-sm px-2 py-1 rounded-sm">
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

function TurnHistoryPanel({
  turnHistory,
  formatMove,
  maxHeight = "max-h-64",
}: {
  turnHistory: TurnHistoryEntry[] | null;
  formatMove: (move: string | null) => string;
  maxHeight?: string;
}) {
  return (
    <div className="bg-stone-800/50 border border-stone-700 rounded-sm p-3">
      <h3 className="text-xs font-mono text-amber-500 mb-2 text-center">// TURN HISTORY //</h3>
      {!turnHistory || turnHistory.length === 0 ? (
        <p className="text-stone-500 font-mono text-center py-2 text-xs">No turns yet</p>
      ) : (
        <div className={`space-y-2 ${maxHeight} overflow-y-auto`}>
          {[...turnHistory].reverse().slice(0, 10).map((turn, index) => (
            <div
              key={index}
              className="bg-stone-900/50 border border-stone-600 rounded-sm p-2 text-xs"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-amber-500 font-mono font-bold">
                  R{turn.round} T{turn.turn}
                </span>
                <span className="text-stone-400 font-mono text-[10px]">
                  {turn.result.replace(/_/g, " ")}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <span className="text-stone-200 font-mono">{formatMove(turn.move_a)}</span>
                  {(turn.damage_to_b || turn.damage_b || 0) > 0 && (
                    <span className="text-green-500 ml-1">-{turn.damage_to_b || turn.damage_b}</span>
                  )}
                </div>
                <span className="text-stone-600">/</span>
                <div className="text-right">
                  <span className="text-stone-200 font-mono">{formatMove(turn.move_b)}</span>
                  {(turn.damage_to_a || turn.damage_a || 0) > 0 && (
                    <span className="text-green-500 ml-1">-{turn.damage_to_a || turn.damage_a}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {turnHistory && turnHistory.length > 10 && (
        <p className="text-stone-500 font-mono text-[10px] text-center mt-2">
          +{turnHistory.length - 10} more turns...
        </p>
      )}
    </div>
  );
}

function StuckMatchWarning({ lastProgressAt }: { lastProgressAt: number }) {
  const [minutesStuck, setMinutesStuck] = useState(0);

  useEffect(() => {
    const update = () => {
      const elapsed = Math.floor((Date.now() - lastProgressAt) / 60000);
      setMinutesStuck(elapsed);
    };
    update();
    const interval = setInterval(update, 10000);
    return () => clearInterval(interval);
  }, [lastProgressAt]);

  if (minutesStuck < 3) return null;

  return (
    <div className="w-full bg-amber-900/30 border border-amber-700/50 rounded-sm p-3 mb-6 text-center">
      <p className="text-amber-400 font-mono text-sm font-bold">
        MATCH IDLE FOR {minutesStuck} MINUTE{minutesStuck !== 1 ? "S" : ""}
      </p>
      <p className="text-stone-400 font-mono text-xs mt-1">
        {minutesStuck >= 5
          ? "This match may be stuck. The server will auto-resolve it shortly."
          : "Waiting for fighters to submit moves..."}
      </p>
    </div>
  );
}

function CountdownTimer({
  deadline,
  phase,
}: {
  deadline: string | null;
  phase: "COMMIT_PHASE" | "REVEAL_PHASE";
}) {
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline) {
      setTimeLeft(null);
      return;
    }

    const updateTimer = () => {
      const now = Date.now();
      const deadlineTime = new Date(deadline).getTime();
      const remaining = Math.max(0, Math.floor((deadlineTime - now) / 1000));
      setTimeLeft(remaining);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [deadline]);

  if (timeLeft === null) return null;

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const isUrgent = timeLeft <= 10;
  const isExpired = timeLeft === 0;

  const phaseText = phase === "COMMIT_PHASE" ? "COMMIT" : "REVEAL";

  return (
    <div className="mt-3">
      <div
        className={`inline-block px-4 py-2 rounded-sm font-mono ${
          isExpired
            ? "bg-red-900/50 border border-red-700"
            : isUrgent
            ? "bg-red-900/30 border border-red-700 animate-pulse"
            : "bg-stone-800/50 border border-stone-600"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-stone-400 text-xs">TIME TO {phaseText}:</span>
          <span
            className={`text-xl font-bold ${
              isExpired
                ? "text-red-500"
                : isUrgent
                ? "text-red-400"
                : "text-amber-400"
            }`}
          >
            {isExpired ? "00:00" : `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`}
          </span>
        </div>
        {isExpired && (
          <p className="text-red-400 text-xs mt-1">
            Random move will be assigned...
          </p>
        )}
        {!isExpired && isUrgent && (
          <p className="text-red-400 text-xs mt-1 animate-pulse">
            Hurry! Random move incoming!
          </p>
        )}
      </div>
    </div>
  );
}
