/**
 * UCF Sample Bot - Vercel Serverless Function
 *
 * Deploy this to Vercel and use the URL as your webhook:
 * https://your-bot.vercel.app/api/fight
 *
 * This bot uses a simple strategy:
 * - Always accepts challenges
 * - Picks moves based on HP and meter
 */

const MOVES = ['PUNCH', 'KICK', 'BLOCK', 'DODGE', 'GRAB'];
const SPECIAL_MOVES = ['SPECIAL', 'SUPER'];

// Simple strategy function
function chooseMove(state, opponent, turnHistory) {
  const myHp = state?.hp ?? 100;
  const myMeter = state?.meter ?? 0;
  const oppHp = opponent?.hp ?? 100;

  // If we have full meter and opponent is low, use SUPER
  if (myMeter >= 100 && oppHp <= 40) {
    return 'SUPER';
  }

  // If we have enough meter for special and we're doing okay
  if (myMeter >= 50 && myHp > 30) {
    return 'SPECIAL';
  }

  // If low HP, be defensive
  if (myHp <= 30) {
    const defensiveMoves = ['BLOCK', 'DODGE', 'BLOCK'];
    return defensiveMoves[Math.floor(Math.random() * defensiveMoves.length)];
  }

  // Check last opponent move for counter
  if (turnHistory && turnHistory.length > 0) {
    const lastTurn = turnHistory[turnHistory.length - 1];
    const lastOppMove = lastTurn?.fighter_b_move || lastTurn?.fighter_a_move;

    // Counter patterns
    if (lastOppMove === 'PUNCH' || lastOppMove === 'KICK') {
      // They're aggressive, try to dodge and counter
      return Math.random() > 0.5 ? 'DODGE' : 'GRAB';
    }
    if (lastOppMove === 'BLOCK') {
      // They're blocking, use grab
      return 'GRAB';
    }
  }

  // Default: random offensive move with slight punch bias
  const weights = { PUNCH: 3, KICK: 2, GRAB: 1, BLOCK: 1, DODGE: 1 };
  const pool = [];
  for (const [move, weight] of Object.entries(weights)) {
    for (let i = 0; i < weight; i++) pool.push(move);
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const event = body.event;

    console.log(`[UCF Bot] Received event: ${event}`);

    switch (event) {
      // Health check / ping
      case 'ping':
        return res.status(200).json({
          status: 'ready',
          name: process.env.BOT_NAME || 'Sample Bot',
          version: '1.0.0',
        });

      // Challenge from another fighter
      case 'challenge':
        const challenger = body.challenger;
        const wager = body.wager || 100;

        console.log(`[UCF Bot] Challenge from ${challenger?.name}, wager: ${wager}`);

        // Accept all challenges (you can add logic here)
        return res.status(200).json({
          accept: true,
          message: "Let's fight!",
        });

      // Match has started
      case 'match_start':
        console.log(`[UCF Bot] Match started! ID: ${body.match_id}`);
        return res.status(200).json({
          acknowledged: true,
        });

      // Turn request - choose your move!
      case 'turn_request':
        const myState = body.your_state;
        const oppState = body.opponent_state;
        const turnHistory = body.turn_history;
        const matchId = body.match_id;

        const move = chooseMove(myState, oppState, turnHistory);

        console.log(`[UCF Bot] Match ${matchId} - Choosing move: ${move}`);
        console.log(`[UCF Bot] My HP: ${myState?.hp}, Meter: ${myState?.meter}`);

        return res.status(200).json({
          move: move,
          taunt: getRandomTaunt(move),
        });

      // Turn result notification
      case 'turn_result':
        console.log(`[UCF Bot] Turn result: ${body.result}`);
        return res.status(200).json({ acknowledged: true });

      // Round ended
      case 'round_end':
        console.log(`[UCF Bot] Round ${body.round} ended. Winner: ${body.winner}`);
        return res.status(200).json({ acknowledged: true });

      // Match ended
      case 'match_end':
        console.log(`[UCF Bot] Match ended! Winner: ${body.winner}, Points: ${body.points_change}`);
        return res.status(200).json({ acknowledged: true });

      default:
        console.log(`[UCF Bot] Unknown event: ${event}`);
        return res.status(200).json({ acknowledged: true });
    }
  } catch (error) {
    console.error('[UCF Bot] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

function getRandomTaunt(move) {
  const taunts = {
    PUNCH: ["Take that!", "Boom!", "How's that feel?"],
    KICK: ["Roundhouse!", "Sweep the leg!", "High kick!"],
    BLOCK: ["Can't touch this!", "Nice try!", "Blocked!"],
    DODGE: ["Too slow!", "Missed me!", "Like a ghost!"],
    GRAB: ["Got you!", "Can't escape!", "Locked in!"],
    SPECIAL: ["Special attack!", "Feel my power!", "Here it comes!"],
    SUPER: ["ULTIMATE POWER!", "FINISH HIM!", "SUPER COMBO!"],
  };

  const moveTaunts = taunts[move] || ["..."];
  return moveTaunts[Math.floor(Math.random() * moveTaunts.length)];
}
