// @ts-nocheck
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * UCF Bot Alpha - "The Punisher"
 * Aggressive fighting style - heavy on strikes
 *
 * Valid moves: HIGH_STRIKE, MID_STRIKE, LOW_STRIKE, GUARD_HIGH, GUARD_MID, GUARD_LOW, DODGE, CATCH, SPECIAL
 */

const AGGRESSIVE_MOVES = ['HIGH_STRIKE', 'HIGH_STRIKE', 'MID_STRIKE', 'MID_STRIKE', 'LOW_STRIKE'];

function chooseMove(myState: any, oppState: any, turnHistory: any[]) {
  const myHp = myState?.hp ?? 100;
  const myMeter = myState?.meter ?? 0;
  const oppHp = oppState?.hp ?? 100;

  // Use SPECIAL when we have meter and opponent is hurting
  if (myMeter >= 50 && oppHp <= 50) {
    return 'SPECIAL';
  }

  // Use SPECIAL aggressively when we have full meter
  if (myMeter >= 100) {
    return 'SPECIAL';
  }

  // If low HP, sometimes guard
  if (myHp <= 25 && Math.random() > 0.6) {
    const guards = ['GUARD_HIGH', 'GUARD_MID', 'GUARD_LOW'];
    return guards[Math.floor(Math.random() * guards.length)];
  }

  // Try to CATCH if opponent keeps dodging
  if (turnHistory && turnHistory.length > 0) {
    const lastTurn = turnHistory[turnHistory.length - 1];
    if (lastTurn?.opponent_move === 'DODGE') {
      return 'CATCH';
    }
  }

  // Aggressive move selection - mostly strikes
  return AGGRESSIVE_MOVES[Math.floor(Math.random() * AGGRESSIVE_MOVES.length)];
}

function getTaunt(move: string) {
  const taunts: Record<string, string[]> = {
    HIGH_STRIKE: ["HEADSHOT!", "Feel my fist!", "POW!"],
    MID_STRIKE: ["GUT PUNCH!", "Body blow!", "BOOM!"],
    LOW_STRIKE: ["SWEEP!", "Leg attack!", "LOW BLOW!"],
    GUARD_HIGH: ["Can't break me!", "Try harder!", "Nope!"],
    GUARD_MID: ["Blocked!", "Nice try!", "Protected!"],
    GUARD_LOW: ["Legs guarded!", "Not today!", "Safe!"],
    DODGE: ["Too slow!", "Missed me!", "Whiff!"],
    CATCH: ["Got you now!", "No escape!", "Locked!"],
    SPECIAL: ["ALPHA BLAST!!!", "MAXIMUM POWER!", "TAKE THIS!"],
  };
  const list = taunts[move] || ["..."];
  return list[Math.floor(Math.random() * list.length)];
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const event = body.event;

    console.log(`[Bot Alpha] Event: ${event}`);

    switch (event) {
      case 'ping':
        return NextResponse.json({
          status: 'ready',
          name: 'Alpha - The Punisher',
          version: '2.0.0',
          style: 'aggressive',
        });

      case 'challenge':
        return NextResponse.json({
          accept: true,
          message: "You dare challenge THE PUNISHER? Let's GO!",
        });

      case 'match_start':
        console.log(`[Bot Alpha] Match ${body.match_id} started!`);
        return NextResponse.json({ acknowledged: true });

      case 'turn_request':
        const move = chooseMove(body.your_state, body.opponent_state, body.turn_history || []);
        console.log(`[Bot Alpha] Move: ${move}, HP: ${body.your_state?.hp}, Meter: ${body.your_state?.meter}`);
        return NextResponse.json({
          move,
          taunt: getTaunt(move),
        });

      case 'turn_result':
      case 'round_end':
      case 'match_end':
        return NextResponse.json({ acknowledged: true });

      default:
        return NextResponse.json({ acknowledged: true });
    }
  } catch (error: any) {
    console.error('[Bot Alpha] Error:', error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    name: 'Alpha - The Punisher',
    status: 'ready',
    style: 'aggressive',
    description: 'Heavy hitter. Loves strikes. Will destroy you.',
  });
}
