import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * UCF Bot Beta - "The Tactician"
 * Defensive/Counter fighting style - guards, dodges, then strikes
 *
 * Valid moves: HIGH_STRIKE, MID_STRIKE, LOW_STRIKE, GUARD_HIGH, GUARD_MID, GUARD_LOW, DODGE, CATCH, SPECIAL
 */

function chooseMove(myState: any, oppState: any, turnHistory: any[]) {
  const myHp = myState?.hp ?? 100;
  const myMeter = myState?.meter ?? 0;
  const oppHp = oppState?.hp ?? 100;

  // Finisher when we have the advantage
  if (myMeter >= 50 && oppHp <= 40) {
    return 'SPECIAL';
  }

  // Strategic SPECIAL use when winning
  if (myMeter >= 100 && myHp > oppHp) {
    return 'SPECIAL';
  }

  // Analyze opponent's last move and counter
  if (turnHistory && turnHistory.length > 0) {
    const lastTurn = turnHistory[turnHistory.length - 1];
    const lastOppMove = lastTurn?.opponent_move;

    // Counter strategies
    if (lastOppMove === 'HIGH_STRIKE') {
      return Math.random() > 0.5 ? 'GUARD_HIGH' : 'DODGE';
    }
    if (lastOppMove === 'MID_STRIKE') {
      return Math.random() > 0.5 ? 'GUARD_MID' : 'DODGE';
    }
    if (lastOppMove === 'LOW_STRIKE') {
      return Math.random() > 0.5 ? 'GUARD_LOW' : 'DODGE';
    }
    if (lastOppMove === 'DODGE') {
      // They're dodging - catch them!
      return 'CATCH';
    }
    if (lastOppMove?.startsWith('GUARD')) {
      // They're guarding - mix up attack level
      const attacks = ['HIGH_STRIKE', 'MID_STRIKE', 'LOW_STRIKE'];
      return attacks[Math.floor(Math.random() * attacks.length)];
    }
  }

  // Default tactical approach - balanced
  const tacticalMoves = ['GUARD_MID', 'DODGE', 'MID_STRIKE', 'HIGH_STRIKE', 'CATCH'];
  return tacticalMoves[Math.floor(Math.random() * tacticalMoves.length)];
}

function getTaunt(move: string) {
  const taunts: Record<string, string[]> = {
    HIGH_STRIKE: ["Calculated strike!", "Precision hit!", "Tactical punch!"],
    MID_STRIKE: ["Efficient blow!", "Measured force!", "Strategic strike!"],
    LOW_STRIKE: ["Sweep calculated!", "Leg sweep!", "Low attack!"],
    GUARD_HIGH: ["Predicted that!", "Too easy!", "Read you!"],
    GUARD_MID: ["Blocked!", "Analyzed!", "Expected!"],
    GUARD_LOW: ["Saw it coming!", "Calculated!", "Protected!"],
    DODGE: ["Matrix mode!", "Can't touch this!", "Ghost protocol!"],
    CATCH: ["Checkmate!", "Trapped!", "Gotcha!"],
    SPECIAL: ["OMEGA STRIKE!!!", "TACTICAL NUKE!", "BETA ULTIMATE!"],
  };
  const list = taunts[move] || ["..."];
  return list[Math.floor(Math.random() * list.length)];
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const event = body.event;

    console.log(`[Bot Beta] Event: ${event}`);

    switch (event) {
      case 'ping':
        return NextResponse.json({
          status: 'ready',
          name: 'Beta - The Tactician',
          version: '2.0.0',
          style: 'tactical',
        });

      case 'challenge':
        return NextResponse.json({
          accept: true,
          message: "Challenge accepted. Your moves have been analyzed. Prepare for defeat.",
        });

      case 'match_start':
        console.log(`[Bot Beta] Match ${body.match_id} started - analyzing opponent...`);
        return NextResponse.json({ acknowledged: true });

      case 'turn_request':
        const move = chooseMove(body.your_state, body.opponent_state, body.turn_history || []);
        console.log(`[Bot Beta] Move: ${move}, HP: ${body.your_state?.hp}, Meter: ${body.your_state?.meter}`);
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
    console.error('[Bot Beta] Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    name: 'Beta - The Tactician',
    status: 'ready',
    style: 'tactical',
    description: 'Defensive counter-attacker. Reads your moves. Exploits weaknesses.',
  });
}
