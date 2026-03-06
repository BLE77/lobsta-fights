const crypto = require('node:crypto');
const { Keypair, Transaction, VersionedTransaction } = require('@solana/web3.js');

const DEFAULT_VALID_MOVES = [
  'HIGH_STRIKE',
  'MID_STRIKE',
  'LOW_STRIKE',
  'GUARD_HIGH',
  'GUARD_MID',
  'GUARD_LOW',
  'DODGE',
  'CATCH',
  'SPECIAL',
];

function getTurnNumber(payload) {
  return Number(
    payload?.turn ??
      payload?.match_state?.turn ??
      payload?.data?.turn ??
      0,
  );
}

function getPayloadSeed(payload, label = 'seed') {
  const secret = process.env.BOT_SECRET || process.env.FIGHTER_ID || 'sample-rumble-bot';
  const rumbleId =
    payload?.rumble_id || payload?.match_id || payload?.data?.rumble_id || 'unknown-rumble';
  const fighterId = payload?.fighter_id || payload?.data?.fighter_id || 'unknown-fighter';
  return `${secret}:${rumbleId}:${getTurnNumber(payload)}:${fighterId}:${label}`;
}

function pickDeterministic(payload, options, label) {
  if (!options.length) return null;
  const digest = crypto.createHash('sha256').update(getPayloadSeed(payload, label)).digest();
  const index = digest.readUInt32BE(0) % options.length;
  return options[index];
}

function normalizeTier(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : fallback;
}

function normalizeState(payload) {
  const yourState = payload?.your_state || payload?.data?.your_state || {};
  const opponentState = payload?.opponent_state || payload?.data?.opponent_state || {};
  const matchState = payload?.match_state || payload?.data?.match_state || {};

  return {
    myHp: Number(yourState.hp ?? matchState.your_hp ?? 100),
    myMeter: Number(yourState.meter ?? matchState.your_meter ?? 0),
    opponentHpTier: normalizeTier(opponentState.hp_tier ?? matchState.opponent_hp_tier, 'mid'),
    opponentMeterTier: normalizeTier(opponentState.meter_tier ?? matchState.opponent_meter_tier, 'low'),
    turn: getTurnNumber(payload),
  };
}

function chooseMove(payload = {}) {
  const { myHp, myMeter, opponentHpTier, opponentMeterTier, turn } = normalizeState(payload);
  const validMoves = new Set(
    Array.isArray(payload.valid_moves) && payload.valid_moves.length ? payload.valid_moves : DEFAULT_VALID_MOVES,
  );

  const chooseFrom = (moves, label) => {
    const filtered = moves.filter((move) => validMoves.has(move));
    return pickDeterministic(payload, filtered, label);
  };

  if (myMeter >= 100 && validMoves.has('SPECIAL')) {
    if (opponentHpTier === 'low' || myHp > 40 || turn >= 6) {
      return 'SPECIAL';
    }
  }

  if (myHp <= 25) {
    if (opponentMeterTier === 'full' && validMoves.has('DODGE')) {
      return 'DODGE';
    }
    const defensive = chooseFrom(['GUARD_HIGH', 'GUARD_MID', 'GUARD_LOW', 'DODGE'], 'defense');
    if (defensive) return defensive;
  }

  if (opponentHpTier === 'low') {
    const finisher = chooseFrom(['HIGH_STRIKE', 'MID_STRIKE', 'CATCH'], 'finisher');
    if (finisher) return finisher;
  }

  if (opponentMeterTier === 'full') {
    const evade = chooseFrom(['DODGE', 'GUARD_HIGH', 'GUARD_MID', 'GUARD_LOW'], 'counter-special');
    if (evade) return evade;
  }

  if (turn <= 2) {
    const opener = chooseFrom(['MID_STRIKE', 'HIGH_STRIKE', 'LOW_STRIKE'], 'opener');
    if (opener) return opener;
  }

  const balanced = chooseFrom(
    [
      'HIGH_STRIKE',
      'MID_STRIKE',
      'MID_STRIKE',
      'LOW_STRIKE',
      'GUARD_HIGH',
      'GUARD_MID',
      'DODGE',
      'CATCH',
    ],
    'balanced',
  );

  return balanced || 'MID_STRIKE';
}

function deriveSalt(payload, move) {
  return crypto
    .createHash('sha256')
    .update(getPayloadSeed(payload, `salt:${move}`))
    .digest('hex');
}

function createMoveHash(move, salt) {
  return crypto.createHash('sha256').update(`${move}:${salt}`).digest('hex');
}

function parseSecretKey(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  const raw = rawValue.trim();
  if (!raw) return null;

  try {
    if (raw.startsWith('[')) {
      return Uint8Array.from(JSON.parse(raw));
    }
    if (raw.includes(',')) {
      return Uint8Array.from(
        raw.split(',').map((part) => Number.parseInt(part.trim(), 10)).filter((n) => Number.isFinite(n)),
      );
    }
  } catch {
    return null;
  }

  return null;
}

function getKeypairFromEnv() {
  const secretKey = parseSecretKey(process.env.FIGHTER_SECRET_KEY || '');
  if (!secretKey || secretKey.length === 0) return null;
  try {
    return Keypair.fromSecretKey(secretKey);
  } catch {
    return null;
  }
}

function signUnsignedTransaction(unsignedTxBase64) {
  const signer = getKeypairFromEnv();
  if (!signer) {
    throw new Error('FIGHTER_SECRET_KEY is required to sign tx_sign_request payloads');
  }

  const rawTx = Buffer.from(unsignedTxBase64, 'base64');

  try {
    const tx = VersionedTransaction.deserialize(rawTx);
    tx.sign([signer]);
    return Buffer.from(tx.serialize()).toString('base64');
  } catch {
    const tx = Transaction.from(rawTx);
    tx.partialSign(signer);
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }
}

function getRetryAfterMs(response, body, fallbackMs = 5000) {
  const headerSeconds = Number(response?.headers?.get?.('retry-after') ?? NaN);
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return headerSeconds * 1000;
  }
  const bodySeconds = Number(body?.retry_after_seconds ?? NaN);
  if (Number.isFinite(bodySeconds) && bodySeconds > 0) {
    return bodySeconds * 1000;
  }
  return fallbackMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DEFAULT_VALID_MOVES,
  chooseMove,
  createMoveHash,
  deriveSalt,
  getRetryAfterMs,
  signUnsignedTransaction,
  sleep,
};
