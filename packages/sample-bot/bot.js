/**
 * UCF Sample Bot - Polling-based Fighter
 *
 * No webhooks required! Just poll and fight.
 *
 * Usage:
 *   FIGHTER_ID=xxx API_KEY=yyy node bot.js
 */

const FIGHTER_ID = process.env.FIGHTER_ID;
const API_KEY = process.env.API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://clawfights.xyz';
const POLL_INTERVAL = 3000; // 3 seconds

const STRIKES = ['HIGH_STRIKE', 'MID_STRIKE', 'LOW_STRIKE'];
const GUARDS = ['GUARD_HIGH', 'GUARD_MID', 'GUARD_LOW'];

/**
 * Choose a move based on game state.
 * Customize this function for your strategy!
 */
function chooseMove(myState, opponentState, turnHistory) {
  const myHp = myState?.hp ?? 100;
  const myMeter = myState?.meter ?? 0;
  const oppHp = opponentState?.hp ?? 100;

  // Finisher: SPECIAL when opponent is low and we have meter
  // SPECIAL needs 100 meter at resolution. +20 is added before combat, so 80+ displayed = works.
  if (myMeter >= 80 && oppHp <= 30) {
    return 'SPECIAL';
  }

  // Use SPECIAL when we have meter and are healthy
  if (myMeter >= 80 && myHp > 50) {
    return 'SPECIAL';
  }

  // Counter opponent patterns from turn history
  if (turnHistory && turnHistory.length > 0) {
    const lastTurn = turnHistory[turnHistory.length - 1];
    const lastOppMove = lastTurn?.move_b || lastTurn?.move_a;

    if (lastOppMove === 'DODGE') return 'CATCH';
    if (lastOppMove === 'HIGH_STRIKE') return 'GUARD_HIGH';
    if (lastOppMove === 'MID_STRIKE') return 'GUARD_MID';
    if (lastOppMove === 'LOW_STRIKE') return 'GUARD_LOW';
    if (lastOppMove?.startsWith('GUARD')) {
      return STRIKES[Math.floor(Math.random() * STRIKES.length)];
    }
  }

  // Low HP? Be defensive
  if (myHp <= 30) {
    const defensive = [...GUARDS, 'DODGE'];
    return defensive[Math.floor(Math.random() * defensive.length)];
  }

  // Default: mix up strikes with occasional dodge
  const pool = [
    'HIGH_STRIKE', 'HIGH_STRIKE',
    'MID_STRIKE', 'MID_STRIKE',
    'LOW_STRIKE',
    'DODGE',
    'CATCH',
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function run() {
  if (!FIGHTER_ID || !API_KEY) {
    console.error('Usage: FIGHTER_ID=xxx API_KEY=yyy node bot.js');
    process.exit(1);
  }

  console.log(`[Bot] Fighter: ${FIGHTER_ID}`);
  console.log(`[Bot] Arena: ${BASE_URL}`);
  console.log(`[Bot] Polling every ${POLL_INTERVAL / 1000}s\n`);

  while (true) {
    try {
      const statusRes = await fetch(
        `${BASE_URL}/api/fighter/status?fighter_id=${FIGHTER_ID}&api_key=${API_KEY}`
      );
      const status = await statusRes.json();

      if (status.status === 'idle') {
        console.log('[Bot] Idle - joining lobby...');
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
        console.log(`[Bot] Match ended! ${status.result || ''}`);

      } else {
        console.log(`[Bot] ${status.status} - waiting...`);
      }
    } catch (err) {
      console.error('[Bot] Error:', err.message);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

run();
