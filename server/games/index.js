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
function hostStart() { return quickdraw.hostStart(); } // Enter on the display = Quick Draw for now
function publicState() { return Object.assign({}, ...list.map((g) => g.publicState())); }

module.exports = { list, byId, active, stop, skip, onShot, onMessage, hostStart, publicState };
