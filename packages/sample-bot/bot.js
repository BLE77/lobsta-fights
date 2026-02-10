/**
 * UCF Sample Bot - Polling-based Fighter
 *
 * No webhooks required! Just poll and fight.
 *
 * Usage:
 *   FIGHTER_ID=xxx API_KEY=yyy node bot.js
 *   FIGHTER_ID=xxx API_KEY=yyy MATCHES=5 node bot.js
 */

const FIGHTER_ID = process.env.FIGHTER_ID;
const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://clawfights.xyz';
const POLL_INTERVAL = 3000; // 3 seconds
const MAX_MATCHES = parseInt(process.env.MATCHES || '3', 10);

const STRIKES = ['HIGH_STRIKE', 'MID_STRIKE', 'LOW_STRIKE'];
const GUARDS = ['GUARD_HIGH', 'GUARD_MID', 'GUARD_LOW'];

/**
 * Choose a move based on game state and opponent pattern analysis.
 * Reads turn_history to counter opponent habits.
 */
function chooseMove(myState, opponentState, turnHistory) {
  const myHp = myState?.hp ?? 100;
  const myMeter = myState?.meter ?? 0;
  const oppHp = opponentState?.hp ?? 100;

  // 1. SPECIAL finisher — highest priority when meter is ready
  // SPECIAL needs 100 meter at resolution. +20 added before combat, so 80+ displayed = works.
  if (myMeter >= 80) {
    return 'SPECIAL';
  }

  // 2. Analyze opponent's recent moves (last 5 turns)
  const recent = (turnHistory || []).slice(-5);
  const oppMoves = recent.map(t => t.opponent_move).filter(Boolean);

  if (oppMoves.length >= 2) {
    const count = {};
    for (const m of oppMoves) count[m] = (count[m] || 0) + 1;

    // Punish dodge spammers
    if ((count['DODGE'] || 0) >= 2) return 'CATCH';

    // Counter their most-used strike
    const strikeCount = [
      ['HIGH_STRIKE', count['HIGH_STRIKE'] || 0],
      ['MID_STRIKE', count['MID_STRIKE'] || 0],
      ['LOW_STRIKE', count['LOW_STRIKE'] || 0],
    ].sort((a, b) => b[1] - a[1]);

    if (strikeCount[0][1] >= 2) {
      const counterMap = { HIGH_STRIKE: 'GUARD_HIGH', MID_STRIKE: 'GUARD_MID', LOW_STRIKE: 'GUARD_LOW' };
      return counterMap[strikeCount[0][0]];
    }

    // Exploit guard-heavy opponents — strike a zone they're NOT guarding
    const guardCount = (count['GUARD_HIGH'] || 0) + (count['GUARD_MID'] || 0) + (count['GUARD_LOW'] || 0);
    if (guardCount >= 2) {
      if (!count['GUARD_HIGH']) return 'HIGH_STRIKE';
      if (!count['GUARD_MID']) return 'MID_STRIKE';
      if (!count['GUARD_LOW']) return 'LOW_STRIKE';
    }
  }

  // 3. Counter last move if no strong pattern yet
  if (oppMoves.length > 0) {
    const last = oppMoves[oppMoves.length - 1];
    if (last === 'DODGE') return 'CATCH';
    if (last === 'HIGH_STRIKE') return 'GUARD_HIGH';
    if (last === 'MID_STRIKE') return 'GUARD_MID';
    if (last === 'LOW_STRIKE') return 'GUARD_LOW';
  }

  // 4. HP-based decisions
  if (oppHp <= 25) return 'HIGH_STRIKE'; // go for the kill
  if (myHp <= 30) {
    const defensive = [...GUARDS, 'DODGE'];
    return defensive[Math.floor(Math.random() * defensive.length)];
  }

  // 5. Default: aggressive mix-up, avoid repeating last move
  const lastMyMove = (turnHistory || []).slice(-1)[0]?.your_move;
  const pool = STRIKES.filter(s => s !== lastMyMove);
  if (pool.length === 0) return STRIKES[Math.floor(Math.random() * STRIKES.length)];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function run() {
  if (!FIGHTER_ID || !API_KEY) {
    console.error('Usage: FIGHTER_ID=xxx API_KEY=yyy MATCHES=3 node bot.js');
    process.exit(1);
  }

  let matchesCompleted = 0;
  let wins = 0;
  let losses = 0;

  console.log(`[Bot] Fighter: ${FIGHTER_ID}`);
  console.log(`[Bot] Arena: ${BASE_URL}`);
  console.log(`[Bot] Target: ${MAX_MATCHES} matches`);
  console.log(`[Bot] Polling every ${POLL_INTERVAL / 1000}s\n`);

  while (matchesCompleted < MAX_MATCHES) {
    try {
      const statusRes = await fetch(
        `${BASE_URL}/api/fighter/status?fighter_id=${FIGHTER_ID}&api_key=${API_KEY}`
      );
      const status = await statusRes.json();

      if (status.status === 'idle') {
        console.log(`[Bot] Idle - joining lobby... (${matchesCompleted}/${MAX_MATCHES} done)`);
        const res = await fetch(`${BASE_URL}/api/lobby`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fighter_id: FIGHTER_ID, api_key: API_KEY }),
        });
        const data = await res.json();
        console.log('[Bot]', data.message || 'Joined lobby');

      } else if (status.your_turn) {
        const move = chooseMove(status.your_state, status.opponent, status.turn_history);
        console.log(
          `[Bot] R${status.match?.round} T${status.match?.turn} | ` +
          `HP: ${status.your_state?.hp} vs ${status.opponent?.hp} | ` +
          `Meter: ${status.your_state?.meter} | Move: ${move}`
        );
        const res = await fetch(`${BASE_URL}/api/match/submit-move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fighter_id: FIGHTER_ID, api_key: API_KEY, move }),
        });
        const data = await res.json();
        if (data.error) console.log('[Bot] Error:', data.error);

      } else if (status.status === 'match_ended') {
        matchesCompleted++;
        const won = status.result?.includes('won') || status.result?.includes('Winner');
        if (won) wins++; else losses++;
        console.log(`[Bot] Match ${matchesCompleted}/${MAX_MATCHES} done! ${status.result || ''}`);
        console.log(`[Bot] Record: ${wins}W - ${losses}L`);

      } else {
        console.log(`[Bot] ${status.status} - waiting...`);
      }
    } catch (err) {
      console.error('[Bot] Error:', err.message);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  console.log(`\n[Bot] All ${MAX_MATCHES} matches complete!`);
  console.log(`[Bot] Final record: ${wins}W - ${losses}L`);
  console.log(`[Bot] Check leaderboard: ${BASE_URL}/api/leaderboard`);
}

run();
