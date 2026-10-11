// Game registry. To add a game: write server/games/<id>.js following the quickdraw.js / bumper.js contract,
// require it here, and give it a zone in config.GAMES.
const { game, bus } = require('../state');
const quickdraw = require('./quickdraw');
const bumper = require('./bumper');

const list = [quickdraw, bumper];
const byId = Object.fromEntries(list.map((g) => [g.id, g]));

bus.on('zone:ready', (id, pids) => { if (byId[id]) byId[id].start(pids); });

function active() { return byId[game.mode] || null; }
function stop() { const a = active(); if (a) a.stop(); }
function skip() { const a = active(); if (a && a.skip) a.skip(); }
function onShot(p, m, receivedAt) { const a = active(); if (a && a.onShot) a.onShot(p, m, receivedAt); }
// Any phone message the core does not understand goes to the running game (stick, dash, ...).
function onMessage(p, m, receivedAt) { const a = active(); if (a && a.onMessage) a.onMessage(p, m, receivedAt); }
// Host pressed start: look at where people are standing. The zone with the most occupants (that reaches its
// minimum) starts right away, skipping hold times and join windows. Nobody in a zone = Quick Draw with the first two.
function hostStart() {
  if (game.mode !== 'lobby') return false;
  const lobby = require('../lobby');
  const { GAMES } = require('../config');
  const candidates = GAMES.filter((g) => !g.comingSoon && byId[g.id])
    .map((g) => ({ g, pids: lobby.zoneOccupants(g.id).slice(0, g.max).map((p) => p.pid) }))
    .filter((c) => c.pids.length >= c.g.min)
    .sort((a, b) => b.pids.length - a.pids.length);
  if (candidates.length) return byId[candidates[0].g.id].start(candidates[0].pids);
  return quickdraw.hostStart();
}
function publicState() { return Object.assign({}, ...list.map((g) => g.publicState())); }

module.exports = { list, byId, active, stop, skip, onShot, onMessage, hostStart, publicState };
