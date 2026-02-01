import { NextResponse } from "next/server";

/**
 * UCF Bot Beta - "The Tactician"
 * Defensive/Counter fighting style - blocks, dodges, then strikes
 */

function chooseMove(myState: any, oppState: any, turnHistory: any[]) {
  const myHp = myState?.hp ?? 100;
  const myMeter = myState?.meter ?? 0;
  const oppHp = oppState?.hp ?? 100;

  // Finisher when we have the advantage
  if (myMeter >= 100 && oppHp <= 40) {
    return 'SUPER';
  }

  // Strategic SPECIAL use
  if (myMeter >= 50 && myHp > oppHp) {
    return 'SPECIAL';
  }

  // Analyze opponent's last move and counter
  if (turnHistory && turnHistory.length > 0) {
    const lastTurn = turnHistory[turnHistory.length - 1];
    const lastOppMove = lastTurn?.opponent_move || lastTurn?.fighter_a_move;

    // Counter strategies
    if (lastOppMove === 'PUNCH' || lastOppMove === 'KICK') {
      // They're aggressive - dodge and counter
      return Math.random() > 0.4 ? 'DODGE' : 'BLOCK';
    }
    if (lastOppMove === 'BLOCK' || lastOppMove === 'DODGE') {
      // They're defensive - grab them!
      return 'GRAB';
    }
    if (lastOppMove === 'GRAB') {
      // Counter grab with quick strike
      return 'PUNCH';
    }
  }

  // Default tactical approach
  const tacticalMoves = ['BLOCK', 'DODGE', 'PUNCH', 'KICK', 'GRAB'];
  const weights = [2, 2, 2, 1, 1]; // Favor defense slightly

  const pool: string[] = [];
  tacticalMoves.forEach((move, i) => {
    for (let j = 0; j < weights[i]; j++) pool.push(move);
  });

  return pool[Math.floor(Math.random() * pool.length)];
}

function getTaunt(move: string) {
  const taunts: Record<string, string[]> = {
    PUNCH: ["Calculated strike!", "Precision hit!", "Tactical punch!"],
    KICK: ["Efficient kick!", "Measured force!", "Strategic strike!"],
    BLOCK: ["Predicted that!", "Too easy!", "Read you like a book!"],
    DODGE: ["Matrix mode!", "Can't touch this!", "Ghost protocol!"],
    GRAB: ["Checkmate!", "Trapped!", "Gotcha!"],
    SPECIAL: ["BETA PROTOCOL!", "Tactical advantage!", "Executing special!"],
    SUPER: ["OMEGA STRIKE!!!", "BETA ULTIMATE!", "TACTICAL NUKE!"],
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
          version: '1.0.0',
          style: 'tactical',
        });

      case 'challenge':
        // Beta analyzes and accepts
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
