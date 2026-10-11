// Bumper (碰碰車): top-down sumo. Everyone steers with a virtual stick, dashes to shove, and the last one
// still inside the shrinking ring wins. Symmetric rules, so nothing to balance.
//
// Game module contract (see games/index.js):
//   id, start(pids), stop(), skip(), onMessage(p, m, receivedAt), phoneScreen(p) -> screen | null, publicState()
const { BUMPER: C } = require('../config');
const { players, game, bus } = require('../state');
const { send, broadcastDisplays, event } = require('../net');

const ID = 'bumper';
let match = null;   // { phase, phaseAt, startedAt, radius, bodies: Map(pid -> body), order: [], result }
let round = 0;

const running = () => game.mode === ID && !!match;
const len = (x, y) => Math.hypot(x, y);

// ---------- lifecycle ----------
function start(pids) {
  if (game.mode !== 'lobby' || pids.length < 2) return false;
  game.mode = ID;
  game.message = '';
  game.participants = new Set(pids);
  round++;
  const now = Date.now();
  match = {
    round, phase: 'ready', phaseAt: now, startedAt: null,
    radius: C.RADIUS,
    bodies: new Map(),
    out: [],            // pids in elimination order (first out first)
    result: null,
  };
  // place everyone evenly around the ring, facing the centre
  pids.forEach((pid, i) => {
    const a = (i / pids.length) * Math.PI * 2 - Math.PI / 2;
    const d = C.RADIUS * 0.6;
    match.bodies.set(pid, {
      pid, x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0,
      stick: { x: 0, y: 0 }, face: { x: -Math.cos(a), y: -Math.sin(a) },
      alive: true, outAt: 0, dashUntil: 0, dashReadyAt: 0, lastHitAt: 0, hits: 0, shoves: 0,
    });
  });
  event(players.get(pids[0]), 'game', `碰碰車第 ${round} 回合：${pids.map((p) => players.get(p).name).join('、')}`);
  bus.emit('phones:push');
  return true;
}

function stop() {
  if (game.mode !== ID) return;
  game.mode = 'lobby';
  game.message = '';
  game.participants = new Set();
  match = null;
  bus.emit('phones:push');
  broadcastDisplays({ t: 'event', kind: 'game', detail: '回到大廳' });
}

function skip() { if (running() && match.phase !== 'result') finish(null); }

function finish(winner) {
  if (!match || match.phase === 'result') return;
  const ranking = [...match.out].reverse();        // last out = best of the losers
  if (winner) ranking.unshift(winner);
  match.result = { winner, ranking };
  if (winner) {
    const w = players.get(winner);
    w.wins++;
    game.champion = winner;
    event(w, 'game', `${w.name} 是最後站著的人`);
  } else {
    event(null, 'game', '碰碰車：沒有贏家');
  }
  match.phase = 'result'; match.phaseAt = Date.now();
  bus.emit('phones:push');
}

// Result shown long enough: everyone gets launched out of the zone so the next crowd can gather.
function end() {
  const pids = [...game.participants];
  game.mode = 'lobby';
  game.participants = new Set();
  match = null;
  for (const pid of pids) bus.emit('player:kick', pid);
  bus.emit('phones:push');
}

// ---------- inputs ----------
function onMessage(p, m) {
  if (!running()) return;
  const b = match.bodies.get(p.pid);
  if (!b || !b.alive) return;
  if (m.t === 'stick') {
    let x = Number(m.x) || 0, y = Number(m.y) || 0;
    const l = len(x, y);
    if (l > 1) { x /= l; y /= l; }
    b.stick = { x, y };
    if (l > 0.3) b.face = { x: x / l, y: y / l };
  } else if (m.t === 'dash') {
    const now = Date.now();
    if (match.phase !== 'play' || now < b.dashReadyAt) return;
    b.dashUntil = now + C.DASH_MS;
    b.dashReadyAt = now + C.DASH_COOLDOWN_MS;
    b.vx = b.face.x * C.DASH_SPEED; b.vy = b.face.y * C.DASH_SPEED;
    broadcastDisplays({ t: 'bumper:dash', pid: p.pid });
    send(p.ws, { t: 'haptic', ms: 40 });
  }
}

bus.on('player:leave', (p) => {
  if (!running()) return;
  const b = match.bodies.get(p.pid);
  if (b && b.alive && match.phase !== 'result') eliminate(b, Date.now());
});

// ---------- simulation ----------
function eliminate(b, now) {
  b.alive = false; b.outAt = now; b.stick = { x: 0, y: 0 };
  match.out.push(b.pid);
  broadcastDisplays({ t: 'bumper:out', pid: b.pid });
  send(players.get(b.pid).ws, { t: 'haptic', ms: 300 });
  bus.emit('phones:push');
}

let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  if (!running()) return;
  const elapsed = now - match.phaseAt;

  if (match.phase === 'ready') {
    if (elapsed >= C.READY_MS) { match.phase = 'play'; match.phaseAt = now; match.startedAt = now; bus.emit('phones:push'); }
    return;
  }
  if (match.phase === 'result') {
    if (elapsed >= C.RESULT_MS) end();
    return;
  }

  // ring shrinks after a grace period so people have to fight
  const t = (now - match.startedAt) / 1000;
  match.radius = t < C.SHRINK_AFTER_S ? C.RADIUS
    : Math.max(C.MIN_RADIUS, C.RADIUS - (C.RADIUS - C.MIN_RADIUS) * Math.min(1, (t - C.SHRINK_AFTER_S) / C.SHRINK_S));

  const alive = [...match.bodies.values()].filter((b) => b.alive);
  // steering
  for (const b of alive) {
    const dashing = now < b.dashUntil;
    if (!dashing) {
      // the stick can only accelerate you up to MAX_SPEED; being knocked faster than that is allowed and decays through damping
      const nx = b.vx + b.stick.x * C.ACCEL * dt, ny = b.vy + b.stick.y * C.ACCEL * dt;
      const ns = len(nx, ny), s0 = len(b.vx, b.vy);
      if (ns <= C.MAX_SPEED || ns < s0) { b.vx = nx; b.vy = ny; }
      const damp = Math.max(0, 1 - C.DAMPING * dt);
      b.vx *= damp; b.vy *= damp;
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
  }
  // collisions: equal masses, elastic along the normal, plus a shove bonus for whoever is dashing
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = len(dx, dy) || 0.001;
      const minD = C.BODY_R * 2;
      if (d >= minD) continue;
      const nx = dx / d, ny = dy / d;
      const overlap = minD - d;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2; b.y += ny * overlap / 2;
      const va = a.vx * nx + a.vy * ny, vb = b.vx * nx + b.vy * ny;
      if (va - vb > 0) { // approaching
        const impulse = (va - vb) * C.BOUNCE + C.BUMP_BONUS;
        a.vx -= nx * impulse; a.vy -= ny * impulse;
        b.vx += nx * impulse; b.vy += ny * impulse;
        const aDash = now < a.dashUntil, bDash = now < b.dashUntil;
        if (aDash && !bDash) { b.vx += nx * C.SHOVE; b.vy += ny * C.SHOVE; a.shoves++; }
        if (bDash && !aDash) { a.vx -= nx * C.SHOVE; a.vy -= ny * C.SHOVE; b.shoves++; }
        a.hits++; b.hits++; a.lastHitAt = now; b.lastHitAt = now;
        broadcastDisplays({ t: 'bumper:bump', a: a.pid, b: b.pid, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, force: Math.abs(va - vb) });
        send(players.get(a.pid).ws, { t: 'haptic', ms: 25 });
        send(players.get(b.pid).ws, { t: 'haptic', ms: 25 });
      }
    }
  }
  // out of the ring
  for (const b of alive) {
    if (len(b.x, b.y) > match.radius + C.BODY_R * 0.4) eliminate(b, now);
  }
  const left = [...match.bodies.values()].filter((b) => b.alive);
  if (left.length <= 1) {
    if (left.length === 1) finish(left[0].pid);
    else finish(match.out[match.out.length - 1] || null); // everyone fell at once: last one out wins
  } else if (t >= C.TIME_LIMIT_S) {
    // time's up: closest to the centre wins
    left.sort((p, q) => len(p.x, p.y) - len(q.x, q.y));
    for (const b of left.slice(1).reverse()) { b.alive = false; match.out.push(b.pid); }
    finish(left[0].pid);
  }
}
setInterval(tick, 1000 / 60);

// ---------- views ----------
function publicState() {
  if (game.mode !== ID || !match) return { bumper: null };
  const now = Date.now();
  return {
    bumper: {
      round: match.round, phase: match.phase, phaseAt: match.phaseAt,
      radius: match.radius, ringRadius: C.RADIUS, bodyR: C.BODY_R,
      timeLeft: match.startedAt ? Math.max(0, C.TIME_LIMIT_S - (now - match.startedAt) / 1000) : C.TIME_LIMIT_S,
      bodies: [...match.bodies.values()].map((b) => {
        const p = players.get(b.pid);
        return { pid: b.pid, name: p.name, color: p.color, x: b.x, y: b.y, vx: b.vx, vy: b.vy, face: b.face, alive: b.alive, outAt: b.outAt, dashing: now < b.dashUntil, dashReady: now >= b.dashReadyAt, hits: b.hits, shoves: b.shoves };
      }),
      result: match.result ? { ...match.result, names: match.result.ranking.map((pid) => players.get(pid).name) } : null,
      readyMs: C.READY_MS, resultMs: C.RESULT_MS,
    },
  };
}

function phoneScreen(p) {
  if (!running()) return null;
  const b = match.bodies.get(p.pid);
  if (!b) return { screen: 'spectate', game: '碰碰車', a: `${match.bodies.size} 人混戰`, b: '', phase: match.phase };
  if (match.phase === 'result') {
    const rank = match.result.ranking.indexOf(p.pid) + 1;
    return { screen: 'bumper-result', outcome: match.result.winner === p.pid ? 'win' : 'lose', rank, total: match.bodies.size, wins: p.wins, winner: match.result.winner ? players.get(match.result.winner).name : null };
  }
  return { screen: 'bumper', phase: match.phase, alive: b.alive, players: match.bodies.size, round: match.round };
}

module.exports = { id: ID, start, stop, skip, onMessage, phoneScreen, publicState };
