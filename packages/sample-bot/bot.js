const {
  chooseMove,
  getRetryAfterMs,
  sleep,
} = require('./lib/rumble');

const FIGHTER_ID = process.env.FIGHTER_ID;
const API_KEY = process.env.API_KEY;
const BASE_URL = (process.env.BASE_URL || 'https://clawfights.xyz').replace(/\/$/, '');
const AUTO_REQUEUE = process.env.AUTO_REQUEUE !== 'false';
const QUEUE_ONLY = process.env.QUEUE_ONLY === 'true';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2500);
const STATUS_LOG_INTERVAL_MS = Number(process.env.STATUS_LOG_INTERVAL_MS || 15000);

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return { response, body };
}

async function joinQueue() {
  const { response, body } = await fetchJson(`${BASE_URL}/api/rumble/queue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      fighter_id: FIGHTER_ID,
      api_key: API_KEY,
      auto_requeue: AUTO_REQUEUE,
    }),
  });

  if (response.ok) {
    console.log(
      `[Queue] Joined rumble queue. position=${body?.position ?? 'n/a'} auto_requeue=${AUTO_REQUEUE}`,
    );
    return true;
  }

  if (response.status === 429) {
    const retryMs = getRetryAfterMs(response, body, 5000);
    console.warn(`[Queue] Rate limited. Retrying in ${Math.ceil(retryMs / 1000)}s.`);
    await sleep(retryMs);
    return false;
  }

  const message = body?.error || body?.message || `HTTP ${response.status}`;
  console.warn(`[Queue] Join failed: ${message}`);
  return false;
}

async function fetchPendingMoves() {
  const { response, body } = await fetchJson(
    `${BASE_URL}/api/rumble/pending-moves?fighter_id=${encodeURIComponent(FIGHTER_ID)}`,
    {
      headers: {
        'x-api-key': API_KEY,
      },
    },
  );

  if (response.ok) {
    return { pending: Array.isArray(body?.pending) ? body.pending : [], retryMs: 0 };
  }

  if (response.status === 429) {
    return {
      pending: [],
      retryMs: getRetryAfterMs(response, body, POLL_INTERVAL_MS * 2),
      rateLimited: true,
    };
  }

  const message = body?.error || body?.message || `HTTP ${response.status}`;
  console.warn(`[PendingMoves] Request failed: ${message}`);
  return { pending: [], retryMs: POLL_INTERVAL_MS * 2 };
}

async function submitMove(requestRow) {
  const payload = requestRow?.request_payload || {};
  const move = chooseMove(payload);
  const { response, body } = await fetchJson(`${BASE_URL}/api/rumble/submit-move`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      fighter_id: FIGHTER_ID,
      rumble_id: requestRow.rumble_id,
      turn: requestRow.turn,
      move,
    }),
  });

  if (response.ok) {
    const opponentName = payload.opponent_name || payload.opponent_id || 'unknown-opponent';
    console.log(
      `[Move] Submitted ${move} for rumble=${requestRow.rumble_id} turn=${requestRow.turn} vs ${opponentName}`,
    );
    return { ok: true, retryMs: 0 };
  }

  if (response.status === 429) {
    const retryMs = getRetryAfterMs(response, body, 5000);
    console.warn(`[Move] Rate limited. Retrying in ${Math.ceil(retryMs / 1000)}s.`);
    return { ok: false, retryMs };
  }

  const message = body?.error || body?.message || `HTTP ${response.status}`;
  console.warn(`[Move] Submit failed: ${message}`);
  return { ok: false, retryMs: POLL_INTERVAL_MS };
}

function formatStatusSummary(body) {
  const slots = Array.isArray(body?.slots) ? body.slots : [];
  if (!slots.length) return 'no slots';
  return slots
    .map((slot) => {
      const fighters = Array.isArray(slot.fighters) ? slot.fighters.length : 0;
      return `slot${slot.slotIndex}:${slot.state}:fighters=${fighters}:turn=${slot.currentTurn ?? 0}`;
    })
    .join(' | ');
}

async function logArenaStatus() {
  const { response, body } = await fetchJson(`${BASE_URL}/api/rumble/status`);
  if (!response.ok) {
    const message = body?.error || body?.message || `HTTP ${response.status}`;
    console.warn(`[Status] Failed: ${message}`);
    return;
  }

  console.log(`[Status] ${formatStatusSummary(body)} | queue=${body?.queueLength ?? 'n/a'}`);
}

async function run() {
  if (!FIGHTER_ID || !API_KEY) {
    console.error('Set FIGHTER_ID and API_KEY environment variables.');
    process.exit(1);
  }

  console.log(`[Bot] Fighter: ${FIGHTER_ID}`);
  console.log(`[Bot] Base URL: ${BASE_URL}`);
  console.log(`[Bot] auto_requeue=${AUTO_REQUEUE} queue_only=${QUEUE_ONLY}`);

  await joinQueue();

  if (QUEUE_ONLY) {
    console.log('[Bot] Queue-only mode complete. Fighter will rely on rumble fallback auto-pilot.');
    return;
  }

  let nextStatusLogAt = 0;

  while (true) {
    try {
      if (Date.now() >= nextStatusLogAt) {
        await logArenaStatus();
        nextStatusLogAt = Date.now() + STATUS_LOG_INTERVAL_MS;
      }

      const { pending, retryMs, rateLimited } = await fetchPendingMoves();
      if (rateLimited) {
        await sleep(retryMs || POLL_INTERVAL_MS);
        continue;
      }

      if (!pending.length) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const result = await submitMove(pending[0]);
      if (result.retryMs > 0) {
        await sleep(result.retryMs);
      }
    } catch (error) {
      console.error('[Bot] Unexpected error:', error?.message || error);
      await sleep(POLL_INTERVAL_MS * 2);
    }
  }
}

run().catch((error) => {
  console.error('[Bot] Fatal error:', error);
  process.exit(1);
});
