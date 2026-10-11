// Parkour (跑酷): everyone runs the same side-scrolling course at once. Same physics as the lobby (shared stepBody),
// checkpoints, pits that send you back, first across the finish wins, everyone else is ranked by time then distance.
//
// Game module contract (see games/index.js):
//   id, start(pids), stop(), skip(), phoneScreen(p) -> screen | null, publicState()
const { PARKOUR: C, WORLD } = require('../config');
const { players, game, bus } = require('../state');
const { broadcastDisplays, event, send } = require('../net');
const lobby = require('../lobby');

const ID = 'parkour';
let race = null;    // { phase, phaseAt, startedAt, bodies: Map(pid -> body), finished: [] }
let round = 0;

const running = () => game.mode === ID && !!race;

function newBody(pid) {
  return {
    pid, pos: { x: C.START_X, y: 0 }, vel: { x: 0, y: 0 }, onGround: true, facing: 1,
    landedAt: 0, jumpedAt: 0, lastGroundAt: 0, wantJumpAt: 0, seenWantAt: 0,
    checkpoint: 0, bestX: C.START_X, falls: 0, finishedAt: null, respawnAt: 0,
  };
}

// ---------- lifecycle ----------
function start(pids) {
  if (game.mode !== 'lobby' || pids.length < 1) return false;
  game.mode = ID;
  game.message = '';
  game.participants = new Set(pids);
  round++;
  race = { round, phase: 'ready', phaseAt: Date.now(), startedAt: null, bodies: new Map(), finished: [], result: null };
  pids.forEach((pid, i) => { const b = newBody(pid); b.pos.x = C.START_X + (i % 4) * 0.5; race.bodies.set(pid, b); });
  event(players.get(pids[0]), 'game', `跑酷第 ${round} 回合：${pids.map((p) => players.get(p).name).join('、')}`);
  bus.emit('phones:push');
  return true;
}

function stop() {
  if (game.mode !== ID) return;
  const pids = [...game.participants];
  game.mode = 'lobby';
  game.message = '';
  game.participants = new Set();
  race = null;
  for (const pid of pids) bus.emit('player:kick', pid);
  bus.emit('phones:push');
  broadcastDisplays({ t: 'event', kind: 'game', detail: '回到大廳' });
}

function skip() { if (running() && race.phase !== 'result') finish(); }

function finish() {
  if (!race || race.phase === 'result') return;
  const now = Date.now();
  // ranking: finishers by time, then the rest by how far they got
  const done = [...race.bodies.values()].filter((b) => b.finishedAt != null).sort((a, b) => a.finishedAt - b.finishedAt);
  const rest = [...race.bodies.values()].filter((b) => b.finishedAt == null).sort((a, b) => b.bestX - a.bestX);
  const ranking = [...done, ...rest].map((b) => b.pid);
  const winner = done.length ? done[0].pid : null;
  race.result = { winner, ranking, times: Object.fromEntries(done.map((b) => [b.pid, b.finishedAt])) };
  if (winner) {
    const w = players.get(winner);
    w.wins++;
    game.champion = winner;
    event(w, 'game', `${w.name} 跑酷第一，${(done[0].finishedAt / 1000).toFixed(2)} 秒`);
  } else event(null, 'game', '跑酷：沒人跑到終點');
  race.phase = 'result'; race.phaseAt = now;
  bus.emit('phones:push');
}

function end() {
  const pids = [...game.participants];
  game.mode = 'lobby';
  game.participants = new Set();
  race = null;
  for (const pid of pids) bus.emit('player:kick', pid);
  bus.emit('phones:push');
}

bus.on('player:leave', (p) => {
  if (!running()) return;
  const b = race.bodies.get(p.pid);
  if (b && b.finishedAt == null && race.phase !== 'result') {
    race.bodies.delete(p.pid);
    if (![...race.bodies.values()].some((x) => x.finishedAt == null)) finish();
  }
});

// ---------- simulation ----------
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  if (!running()) return;
  const elapsed = now - race.phaseAt;
  if (race.phase === 'ready') {
    if (elapsed >= C.READY_MS) { race.phase = 'play'; race.phaseAt = now; race.startedAt = now; bus.emit('phones:push'); }
    return;
  }
  if (race.phase === 'result') { if (elapsed >= C.RESULT_MS) end(); return; }

  for (const b of race.bodies.values()) {
    if (b.finishedAt != null) continue;
    const p = players.get(b.pid);
    if (!p || !p.connected) continue;
    if (now < b.respawnAt) continue; // brief pause after a fall
    // inputs live on the player (lobby.onMove / onJump); hand a fresh tap to this body once
    if (p.wantJumpAt && p.wantJumpAt !== b.seenWantAt) { b.wantJumpAt = p.wantJumpAt; b.seenWantAt = p.wantJumpAt; }
    lobby.stepBody(b, { dir: p.moveDir || 0, jumpHeld: p.jumpHeld, allowJump: true }, C.COURSE, dt, now);
    if (b.pos.x > b.bestX) b.bestX = b.pos.x;
    // checkpoints
    for (let i = C.CHECKPOINTS.length - 1; i > b.checkpoint; i--) {
      if (b.onGround && b.pos.x >= C.CHECKPOINTS[i]) { b.checkpoint = i; send(p.ws, { t: 'haptic', ms: 60 }); broadcastDisplays({ t: 'parkour:checkpoint', pid: b.pid, index: i }); break; }
    }
    // fell into a pit, or stepped on spikes
    const onSpikes = b.onGround && (C.COURSE.hazards || []).some((h) => Math.abs(b.pos.y - h.y) < 0.05 && b.pos.x >= h.x && b.pos.x <= h.x + h.w);
    if (b.pos.y < C.FALL_Y || onSpikes) {
      b.falls++;
      b.pos.x = C.CHECKPOINTS[b.checkpoint]; b.pos.y = surfaceAt(b.pos.x); b.vel.x = 0; b.vel.y = 0; b.onGround = true;
      b.respawnAt = now + 500;
      send(p.ws, { t: 'haptic', ms: 200 });
      broadcastDisplays({ t: 'parkour:fall', pid: b.pid });
    }
    // finish line
    if (b.pos.x >= C.FINISH_X && b.onGround) {
      b.finishedAt = now - race.startedAt;
      race.finished.push(b.pid);
      send(p.ws, { t: 'haptic', ms: 120 });
      broadcastDisplays({ t: 'parkour:finish', pid: b.pid, time: b.finishedAt, place: race.finished.length });
      bus.emit('phones:push');
    }
  }
  const still = [...race.bodies.values()].filter((b) => b.finishedAt == null && players.get(b.pid) && players.get(b.pid).connected);
  const t = (now - race.startedAt) / 1000;
  if (!still.length || t >= C.TIME_LIMIT_S) finish();
}
setInterval(tick, 1000 / 60);

// top of the highest platform at x that is at or below y 100 (used to respawn on a checkpoint)
function surfaceAt(x) {
  let best = 0;
  for (const pl of C.COURSE.platforms) if (x >= pl.x && x <= pl.x + pl.w && pl.y > best) best = pl.y;
  return best;
}

// ---------- views ----------
function publicState() {
  if (game.mode !== ID || !race) return { parkour: null };
  const now = Date.now();
  return {
    parkour: {
      round: race.round, phase: race.phase, phaseAt: race.phaseAt,
      time: race.startedAt ? now - race.startedAt : 0, timeLimit: C.TIME_LIMIT_S,
      course: C.COURSE, checkpoints: C.CHECKPOINTS, finishX: C.FINISH_X, startX: C.START_X,
      bodies: [...race.bodies.values()].map((b) => {
        const p = players.get(b.pid);
        return { pid: b.pid, name: p.name, color: p.color, pos: b.pos, vel: b.vel, onGround: b.onGround, facing: b.facing, landedAt: b.landedAt, jumpedAt: b.jumpedAt, checkpoint: b.checkpoint, falls: b.falls, finishedAt: b.finishedAt, bestX: b.bestX, respawning: now < b.respawnAt };
      }),
      result: race.result ? { ...race.result, names: race.result.ranking.map((pid) => players.get(pid).name) } : null,
      readyMs: C.READY_MS, resultMs: C.RESULT_MS,
    },
  };
}

function phoneScreen(p) {
  if (!running()) return null;
  const b = race.bodies.get(p.pid);
  if (!b) return { screen: 'spectate', game: '跑酷', a: `${race.bodies.size} 人競速`, b: '', phase: race.phase };
  if (race.phase === 'result') {
    const rank = race.result.ranking.indexOf(p.pid) + 1;
    return { screen: 'parkour-result', outcome: race.result.winner === p.pid ? 'win' : 'lose', rank, total: race.result.ranking.length, time: b.finishedAt, falls: b.falls, wins: p.wins, winner: race.result.winner ? players.get(race.result.winner).name : null };
  }
  return { screen: 'parkour', phase: race.phase, finished: b.finishedAt != null, place: b.finishedAt != null ? race.finished.indexOf(p.pid) + 1 : null, time: b.finishedAt, round: race.round, players: race.bodies.size };
}

module.exports = { id: ID, start, stop, skip, phoneScreen, publicState };
