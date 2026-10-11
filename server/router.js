// One place that turns a phone message into state changes. Used by real sockets (index.js) and server-side bots (bots.js).
const P = require('./players');
const lobby = require('./lobby');
const games = require('./games');

function route(p, m, receivedAt = Date.now()) {
  switch (m.t) {
    case 'motion': P.classifyMotion(p, m, receivedAt); break;
    case 'pong': P.onPong(p, m); break;
    case 'shot': games.onShot(p, m, receivedAt); break;
    case 'emoji': lobby.onEmoji(p, m); break;
    case 'jump': lobby.onJump(p, m); break;
    case 'move': lobby.onMove(p, m); break;
    case 'btn': P.onButton(p, m); break;
    case 'calib': p.neutral = null; break;
    case 'name': p.name = String(m.name || '').slice(0, 16) || p.name; break;
    default: games.onMessage(p, m, receivedAt);
  }
}

module.exports = { route };
