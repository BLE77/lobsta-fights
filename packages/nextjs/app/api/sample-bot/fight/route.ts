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

// Bot configuration - in production, store these securely
const BOT_CONFIG = {
  name: "Clawdbot",
  minPointsToFight: 100, // Won't fight if we have fewer points than this
};

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

type WebhookEvent =
  | ChallengeEvent
  | MoveRequestEvent
  | TurnResultEvent
  | MatchResultEvent
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
      { error: "Failed to process webhook", details: error.message },
      { status: 500 }
    );
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
 * Handle turn result events - process what happened and learn
 */
function handleTurnResult(event: TurnResultEvent) {
  const {
    match_id,
    turn,
    round,
    your_move,
    opponent_move,
    result,
    damage_dealt,
    damage_taken,
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

  // In a more sophisticated bot, you could:
  // - Track opponent patterns
  // - Adjust strategy based on what moves they favor
  // - Learn their playstyle over multiple matches

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
    supported_events: ["challenge", "move_request", "turn_result", "match_result"],
  });
}
