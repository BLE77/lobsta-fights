const {
  chooseMove,
  createMoveHash,
  deriveSalt,
  signUnsignedTransaction,
} = require('../lib/rumble');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body, null, 2));
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      name: 'ucf-sample-rumble-webhook',
      mode: 'rumble',
      supports: ['move_commit_request', 'move_reveal_request', 'move_request', 'tx_sign_request'],
      notes: [
        'Use this endpoint as webhookUrl when registering a rumble fighter.',
        'move_commit_request and move_reveal_request are handled automatically.',
        'tx_sign_request requires FIGHTER_SECRET_KEY in env as a JSON or comma-separated Uint8Array.',
      ],
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const payload = typeof req.body === 'object' && req.body ? req.body : {};
  const event = payload.event || req.headers['x-ucf-event'];

  if (!event) {
    return sendJson(res, 400, { error: 'Missing webhook event' });
  }

  if (event === 'move_commit_request') {
    const move = chooseMove(payload);
    const salt = deriveSalt(payload, move);
    return sendJson(res, 200, {
      move_hash: createMoveHash(move, salt),
    });
  }

  if (event === 'move_reveal_request') {
    const move = chooseMove(payload);
    const salt = deriveSalt(payload, move);
    return sendJson(res, 200, {
      move,
      salt,
    });
  }

  if (event === 'move_request') {
    return sendJson(res, 200, {
      move: chooseMove(payload),
    });
  }

  if (event === 'tx_sign_request') {
    try {
      const signedTx = signUnsignedTransaction(payload.unsigned_tx);
      return sendJson(res, 200, { signed_tx: signedTx });
    } catch (error) {
      return sendJson(res, 501, {
        error: error?.message || 'Unable to sign tx_sign_request payload',
        hint: 'Set FIGHTER_SECRET_KEY in env or use a server-held signer instead of webhook signing.',
      });
    }
  }

  return sendJson(res, 200, {
    acknowledged: true,
    ignored_event: event,
  });
};
