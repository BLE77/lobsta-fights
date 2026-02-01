import { NextResponse } from "next/server";

/**
 * UCF Bot Alpha - "The Punisher"
 * Aggressive fighting style - heavy on punches and kicks
 */

const AGGRESSIVE_MOVES = ['PUNCH', 'PUNCH', 'KICK', 'KICK', 'GRAB'];

function chooseMove(myState: any, oppState: any, turnHistory: any[]) {
  const myHp = myState?.hp ?? 100;
  const myMeter = myState?.meter ?? 0;
  const oppHp = oppState?.hp ?? 100;

  // SUPER finisher when opponent is low
  if (myMeter >= 100 && oppHp <= 30) {
    return 'SUPER';
  }

  // Use SPECIAL aggressively
  if (myMeter >= 50) {
    return 'SPECIAL';
  }

  // If low HP, occasionally block
  if (myHp <= 25 && Math.random() > 0.6) {
    return 'BLOCK';
  }

  // Aggressive move selection
  return AGGRESSIVE_MOVES[Math.floor(Math.random() * AGGRESSIVE_MOVES.length)];
}

function getTaunt(move: string) {
  const taunts: Record<string, string[]> = {
    PUNCH: ["ALPHA STRIKE!", "Feel my fist!", "POW!"],
    KICK: ["ALPHA KICK!", "Roundhouse!", "BOOM!"],
    BLOCK: ["Can't break me!", "Try harder!", "Nope!"],
    GRAB: ["Got you now!", "No escape!", "Locked!"],
    SPECIAL: ["ALPHA BLAST!", "Special delivery!", "Take this!"],
    SUPER: ["ALPHA ULTIMATE!!!", "DESTROYER MODE!", "GAME OVER!"],
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
          version: '1.0.0',
          style: 'aggressive',
        });

      case 'challenge':
        // Alpha always accepts - loves to fight!
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    name: 'Alpha - The Punisher',
    status: 'ready',
    style: 'aggressive',
    description: 'Heavy hitter. Loves punches and kicks. Will destroy you.',
  });
}
