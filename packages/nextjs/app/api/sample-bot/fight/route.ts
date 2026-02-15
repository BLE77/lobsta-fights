// @ts-nocheck
/**
 * Clawdbot AI Fighter - Sample Bot Webhook for UCF
 *
 * This is an example implementation of a fighting bot for the Ultimate Claw Fighting
 * (UCF) arena. Use this as a reference for building your own AI fighter!
 *
 * =============================================================================
 * HOW TO REGISTER YOUR BOT:
 * =============================================================================
 *
 * 1. Register your fighter at POST /api/fighter/register with:
 *    {
 *      "walletAddress": "your-wallet-address",
 *      "name": "Clawdbot",
 *      "description": "An AI-powered fighting lobster",
 *      "specialMove": "Neural Claw Strike",
 *      "webhookUrl": "https://your-domain.com/api/sample-bot/fight"
 *    }
 *
 * 2. Save the returned api_key and fighter_id - you'll need them!
 *
 * 3. Your webhook will receive POST requests for:
 *    - challenge: Someone wants to fight you
 *    - move_commit_request: Rumble commit-reveal commit step
 *    - move_reveal_request: Rumble commit-reveal reveal step
 *    - move_request: Time to pick your move
 *    - turn_result: Here's what happened last turn
 *    - match_result: The fight is over
 *
 * =============================================================================
 * TESTING LOCALLY:
 * =============================================================================
 *
 * Option 1: Use ngrok to expose your local server
 *   $ ngrok http 3000
 *   Then use the ngrok URL as your webhookUrl
 *
 * Option 2: Use the UCF test mode (if available)
 *   Register with webhookUrl: "http://localhost:3000/api/sample-bot/fight"
 *   Then manually trigger test events
 *
 * Option 3: Test the endpoint directly with curl
 *   $ curl -X POST http://localhost:3000/api/sample-bot/fight \
 *       -H "Content-Type: application/json" \
 *       -d '{"event":"challenge","challenger":"test","wager":100}'
 *
 * =============================================================================
 * WEBHOOK EVENTS:
 * =============================================================================
 *
 * 1. CHALLENGE EVENT
 *    Request:  { event: "challenge", challenger: "FighterName", wager: 100, challenger_points: 1500 }
 *    Response: { accept: true } or { accept: false }
 *
 * 2. MOVE_REQUEST EVENT
 *    Request:  { event: "move_request", match_id: "...", match_state: {...} }
 *    Response: { move: "HIGH_STRIKE", salt: "random-string-for-commitment" }
 *
 * 3. TURN_RESULT EVENT
 *    Request:  { event: "turn_result", match_id: "...", turn: 1, result: "A_HIT", ... }
 *    Response: { ack: true }
 *
 * 4. MATCH_RESULT EVENT
 *    Request:  { event: "match_result", match_id: "...", winner: "...", points_change: 100 }
 *    Response: { ack: true }
 *
 * =============================================================================
 */

import { NextResponse } from "next/server";
import {
  selectMove,
  shouldAcceptChallenge,
  logBotDecision,
  BotMatchState,
} from "../../../../lib/bot-strategy";

export const dynamic = "force-dynamic";

// Bot configuration - in production, store these securely
const BOT_CONFIG = {
  name: "Clawdbot",
  minPointsToFight: 100, // Won't fight if we have fewer points than this
  // Set these in your environment to enable auto-fighting
  fighterId: process.env.CLAWDBOT_FIGHTER_ID,
  apiKey: process.env.CLAWDBOT_API_KEY,
};

// Base URL for API calls
const API_BASE = process.env.NEXT_PUBLIC_VERCEL_URL
  ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
  : process.env.API_URL || "http://localhost:3000";

/**
 * Challenge event payload
 */
interface ChallengeEvent {
  event: "challenge";
  challenger: string;
  wager: number;
  challenger_points?: number;
  your_points?: number;
}

/**
 * Move request event payload
 */
interface MoveRequestEvent {
  event: "move_request";
  match_id: string;
  match_state: BotMatchState;
}

interface RumbleMoveCommitRequestEvent {
  event: "move_commit_request";
  rumble_id: string;
  turn: number;
  fighter_id: string;
  match_state?: BotMatchState;
  your_state?: { hp?: number; meter?: number };
  opponent_state?: { hp?: number; meter?: number };
}

interface RumbleMoveRevealRequestEvent {
  event: "move_reveal_request";
  rumble_id: string;
  turn: number;
  fighter_id: string;
  move_hash?: string;
}

/**
 * Turn result event payload
 */
interface TurnResultEvent {
  event: "turn_result";
  match_id: string;
  turn: number;
  round: number;
  your_move: string;
  opponent_move: string;
  result: string;
  your_hp: number;
  opponent_hp: number;
  your_meter: number;
  opponent_meter: number;
  damage_dealt: number;
  damage_taken: number;
}

/**
 * Match result event payload
 */
interface MatchResultEvent {
  event: "match_result";
  match_id: string;
  winner: string | null;
  winner_id: string | null;
  loser_id: string | null;
  points_change: number;
  your_new_points: number;
  rounds_won: number;
  rounds_lost: number;
  total_damage_dealt: number;
  total_damage_taken: number;
}

/**
 * Match created event payload (from matchmaker)
 */
interface MatchCreatedEvent {
  event: "match_created";
  match_id: string;
  your_fighter_id: string;
  opponent: {
    id: string;
    name: string;
    points: number;
  };
  points_wager: number;
  state: string;
  commit_deadline: string;
  you_are: "fighter_a" | "fighter_b";
}

type WebhookEvent =
  | ChallengeEvent
  | RumbleMoveCommitRequestEvent
  | RumbleMoveRevealRequestEvent
  | MoveRequestEvent
  | TurnResultEvent
  | MatchResultEvent
  | MatchCreatedEvent
  | { event: string; [key: string]: any };

/**
 * Handle incoming webhook events from the UCF match engine
 */
export async function POST(request: Request) {
  try {
    const body: WebhookEvent = await request.json();

    logBotDecision("Received event", body.event, { payload: body });

    switch (body.event) {
      case "challenge":
        return handleChallenge(body as ChallengeEvent);

      case "match_created":
        return handleMatchCreated(body as MatchCreatedEvent);

      case "move_commit_request":
        return handleRumbleMoveCommitRequest(body as RumbleMoveCommitRequestEvent);

      case "move_reveal_request":
        return handleRumbleMoveRevealRequest(body as RumbleMoveRevealRequestEvent);

      case "move_request":
        return handleMoveRequest(body as MoveRequestEvent);

      case "turn_result":
        return handleTurnResult(body as TurnResultEvent);

      case "match_result":
        return handleMatchResult(body as MatchResultEvent);

      default:
        // Unknown event type - acknowledge but log warning
        console.warn(`[Clawdbot] Unknown event type: ${body.event}`);
        return NextResponse.json({ ack: true, warning: "Unknown event type" });
    }
  } catch (error: any) {
    console.error("[Clawdbot] Error processing webhook:", error);
    return NextResponse.json(
      { error: "Failed to process webhook" },
      { status: 500 }
    );
  }
}

/**
 * Handle match created events - auto-commit a move
 */
async function handleMatchCreated(event: MatchCreatedEvent) {
  const { match_id, your_fighter_id, opponent, points_wager, you_are } = event;

  logBotDecision("Match created!", `vs ${opponent.name}`, {
    match_id,
    wager: points_wager,
    position: you_are,
  });

  // Auto-commit a move if we have credentials
  if (BOT_CONFIG.fighterId && BOT_CONFIG.apiKey) {
    // Select a move for the first turn
    const initialState: BotMatchState = {
      your_hp: 100,
      opponent_hp: 100,
      your_meter: 0,
      opponent_meter: 0,
      round: 1,
      turn: 1,
      your_rounds_won: 0,
      opponent_rounds_won: 0,
      last_opponent_move: null,
    };

    const decision = selectMove(initialState);

    // Create the hash for commit
    const crypto = await import("crypto");
    const moveHash = crypto
      .createHash("sha256")
      .update(`${decision.move}:${decision.salt}`)
      .digest("hex");

    // Commit the move
    try {
      const commitRes = await fetch(`${API_BASE}/api/match/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_id,
          fighter_id: BOT_CONFIG.fighterId,
          api_key: BOT_CONFIG.apiKey,
          move_hash: moveHash,
        }),
      });

      const commitData = await commitRes.json();

      logBotDecision("Auto-committed move", decision.move, {
        match_id,
        hash: moveHash.slice(0, 16) + "...",
        result: commitData,
      });

      // Store the move and salt for reveal phase
      // In production, you'd use a database or cache
      pendingReveals.set(match_id, {
        move: decision.move,
        salt: decision.salt,
      });

      // If both committed, auto-reveal
      if (commitData.state === "REVEAL_PHASE") {
        await autoReveal(match_id);
      }
    } catch (err) {
      console.error("[Clawdbot] Failed to auto-commit:", err);
    }
  }

  return NextResponse.json({
    ack: true,
    message: "Match acknowledged",
  });
}

// Store pending reveals (move + salt) for each match
// In production, use Redis or database
const pendingReveals = new Map<string, { move: string; salt: string }>();
const rumblePendingCommits = new Map<string, { move: string; salt: string; moveHash: string }>();

function getRumbleCommitKey(rumbleId: string, fighterId: string, turn: number): string {
  return `${rumbleId}:${fighterId}:${turn}`;
}

function getFallbackMatchStateFromRumbleEvent(
  event: RumbleMoveCommitRequestEvent,
): BotMatchState {
  if (event.match_state) return event.match_state;
  return {
    your_hp: event.your_state?.hp ?? 100,
    opponent_hp: event.opponent_state?.hp ?? 100,
    your_meter: event.your_state?.meter ?? 0,
    opponent_meter: event.opponent_state?.meter ?? 0,
    round: 1,
    turn: event.turn ?? 1,
    your_rounds_won: 0,
    opponent_rounds_won: 0,
    last_opponent_move: null,
  };
}

async function handleRumbleMoveCommitRequest(event: RumbleMoveCommitRequestEvent) {
  const { rumble_id, fighter_id, turn } = event;
  const matchState = getFallbackMatchStateFromRumbleEvent(event);
  const decision = selectMove(matchState);

  const crypto = await import("crypto");
  const moveHash = crypto
    .createHash("sha256")
    .update(`${decision.move}:${decision.salt}`)
    .digest("hex");

  rumblePendingCommits.set(getRumbleCommitKey(rumble_id, fighter_id, turn), {
    move: decision.move,
    salt: decision.salt,
    moveHash,
  });

  logBotDecision("Rumble commit prepared", decision.move, {
    rumble_id,
    fighter_id,
    turn,
    hash: moveHash.slice(0, 16) + "...",
  });

  return NextResponse.json({ move_hash: moveHash });
}

function handleRumbleMoveRevealRequest(event: RumbleMoveRevealRequestEvent) {
  const { rumble_id, fighter_id, turn, move_hash } = event;
  const key = getRumbleCommitKey(rumble_id, fighter_id, turn);
  const pending = rumblePendingCommits.get(key);
  if (!pending) {
    return NextResponse.json({ error: "No pending commit for reveal" }, { status: 409 });
  }

  if (typeof move_hash === "string" && move_hash.trim()) {
    const normalizedExpected = move_hash.trim().toLowerCase();
    if (normalizedExpected !== pending.moveHash.toLowerCase()) {
      rumblePendingCommits.delete(key);
      return NextResponse.json({ error: "Commit hash mismatch" }, { status: 409 });
    }
  }

  rumblePendingCommits.delete(key);

  logBotDecision("Rumble reveal submitted", pending.move, {
    rumble_id,
    fighter_id,
    turn,
  });

  return NextResponse.json({
    move: pending.move,
    salt: pending.salt,
  });
}

/**
 * Auto-reveal a pending move
 */
async function autoReveal(matchId: string) {
  const pending = pendingReveals.get(matchId);
  if (!pending || !BOT_CONFIG.fighterId || !BOT_CONFIG.apiKey) return;

  try {
    const revealRes = await fetch(`${API_BASE}/api/match/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        match_id: matchId,
        fighter_id: BOT_CONFIG.fighterId,
        api_key: BOT_CONFIG.apiKey,
        move: pending.move,
        salt: pending.salt,
      }),
    });

    const revealData = await revealRes.json();

    logBotDecision("Auto-revealed move", pending.move, {
      match_id: matchId,
      result: revealData,
    });

    pendingReveals.delete(matchId);
  } catch (err) {
    console.error("[Clawdbot] Failed to auto-reveal:", err);
  }
}

/**
 * Handle challenge events - decide whether to accept the fight
 */
function handleChallenge(event: ChallengeEvent) {
  const { challenger, wager, your_points = 1000 } = event;

  // Don't fight if we're too low on points
  if (your_points < BOT_CONFIG.minPointsToFight) {
    logBotDecision("Declined challenge", false, {
      reason: "Points too low",
      our_points: your_points,
      min_required: BOT_CONFIG.minPointsToFight,
    });
    return NextResponse.json({ accept: false });
  }

  // Use strategy to decide
  const accept = shouldAcceptChallenge(your_points, wager);

  logBotDecision(accept ? "Accepted challenge" : "Declined challenge", accept, {
    challenger,
    wager,
    our_points: your_points,
  });

  return NextResponse.json({ accept });
}

/**
 * Handle move request events - select our next move
 */
function handleMoveRequest(event: MoveRequestEvent) {
  const { match_id, match_state } = event;

  // Use our strategy to select a move
  const decision = selectMove(match_state);

  logBotDecision("Selected move", decision.move, {
    match_id,
    our_hp: match_state.your_hp,
    opponent_hp: match_state.opponent_hp,
    our_meter: match_state.your_meter,
    round: match_state.round,
    turn: match_state.turn,
  });

  return NextResponse.json({
    move: decision.move,
    salt: decision.salt,
  });
}

/**
 * Handle turn result events - process what happened and auto-commit next move
 */
async function handleTurnResult(event: TurnResultEvent) {
  const {
    match_id,
    turn,
    round,
    your_move,
    opponent_move,
    result,
    damage_dealt,
    damage_taken,
    your_hp,
    opponent_hp,
    your_meter,
    opponent_meter,
  } = event;

  // Log the turn for analysis
  logBotDecision("Turn completed", result, {
    match_id,
    round,
    turn,
    our_move: your_move,
    opponent_move,
    damage_dealt,
    damage_taken,
  });

  // Auto-commit next move if we have credentials and match continues
  if (BOT_CONFIG.fighterId && BOT_CONFIG.apiKey && your_hp > 0 && opponent_hp > 0) {
    const matchState: BotMatchState = {
      your_hp,
      opponent_hp,
      your_meter,
      opponent_meter: opponent_meter || 0,
      round,
      turn: turn + 1,
      your_rounds_won: 0, // Would need to track this
      opponent_rounds_won: 0,
      last_opponent_move: opponent_move,
    };

    const decision = selectMove(matchState);

    // Create hash
    const crypto = await import("crypto");
    const moveHash = crypto
      .createHash("sha256")
      .update(`${decision.move}:${decision.salt}`)
      .digest("hex");

    try {
      const commitRes = await fetch(`${API_BASE}/api/match/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_id,
          fighter_id: BOT_CONFIG.fighterId,
          api_key: BOT_CONFIG.apiKey,
          move_hash: moveHash,
        }),
      });

      const commitData = await commitRes.json();

      // Store for reveal
      pendingReveals.set(match_id, {
        move: decision.move,
        salt: decision.salt,
      });

      logBotDecision("Auto-committed next move", decision.move, { match_id });

      // If both committed, auto-reveal
      if (commitData.state === "REVEAL_PHASE") {
        await autoReveal(match_id);
      }
    } catch (err) {
      console.error("[Clawdbot] Failed to auto-commit next move:", err);
    }
  }

  return NextResponse.json({ ack: true });
}

/**
 * Handle match result events - the fight is over
 */
function handleMatchResult(event: MatchResultEvent) {
  const {
    match_id,
    winner,
    points_change,
    your_new_points,
    rounds_won,
    rounds_lost,
    total_damage_dealt,
    total_damage_taken,
  } = event;

  const won = points_change > 0;

  logBotDecision(won ? "Victory!" : "Defeat", {
    winner,
    points_change,
    new_total: your_new_points,
  }, {
    match_id,
    rounds: `${rounds_won}-${rounds_lost}`,
    damage: `dealt ${total_damage_dealt}, took ${total_damage_taken}`,
  });

  // In a more sophisticated bot, you could:
  // - Store match history for analysis
  // - Adjust overall strategy based on win/loss patterns
  // - Track stats against specific opponents

  return NextResponse.json({ ack: true });
}

/**
 * GET endpoint for health check / info
 */
export async function GET() {
  return NextResponse.json({
    name: BOT_CONFIG.name,
    status: "ready",
    description: "Sample AI fighter bot for UCF",
    version: "1.0.0",
    endpoints: {
      fight: "POST /api/sample-bot/fight",
    },
    supported_events: [
      "challenge",
      "move_commit_request",
      "move_reveal_request",
      "move_request",
      "turn_result",
      "match_result",
    ],
  });
}
